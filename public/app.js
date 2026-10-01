"use strict";

const WORKER_URL = "";
const DEFAULT_PACK_SIZE = 10;

const MAX_FILES_TOTAL = 500;
const MAX_FILE_MB = 50;
const PHOTO_MAX_MB = 10;

const PACK_OPTIONS = [5, 6, 7, 8, 9, 10];

/*
 * Two packs can upload at the same time.
 * Increase carefully if the Raven server can handle it.
 */
const CONCURRENT_UPLOADS = 2;

const state = {
  items: [],
  packSize: DEFAULT_PACK_SIZE,

  sending: false,

  sent: 0,
  currentPack: 0,

  objectUrls: new Set(),

  previewObserver: null,

  uploadLoaded: 0,
  uploadTotal: 0
};

const $ = (id) =>
  document.getElementById(id);

const dropzone = $("dropzone");
const imageInput = $("imageInput");
const videoInput = $("videoInput");

const packsEl = $("packs");

const sendBtn = $("sendBtn");
const clearBtn = $("clearBtn");

const captionEl = $("caption");

const apiStatus = $("apiStatus");

function formatBytes(bytes) {
  if (
    !Number.isFinite(bytes) ||
    bytes <= 0
  ) {
    return "0 B";
  }

  const units = [
    "B",
    "KB",
    "MB",
    "GB"
  ];

  const index = Math.min(
    Math.floor(
      Math.log(bytes) /
      Math.log(1024)
    ),
    units.length - 1
  );

  return `${(
    bytes /
    Math.pow(1024, index)
  ).toFixed(
    index === 0 ? 0 : 1
  )} ${units[index]}`;
}

/* =========================
   MESSAGES
========================= */

function setMessage(type, text) {
  const el = $("message");

  if (!text) {
    el.hidden = true;
    el.textContent = "";
    el.className = "message";
    return;
  }

  el.hidden = false;
  el.textContent = text;

  el.className =
    `message ${type || ""}`;
}

/* =========================
   API STATUS
========================= */

function setApiStatus(
  type,
  text
) {
  apiStatus.textContent = text;

  apiStatus.className =
    `pill pill-${type}`;
}

/* =========================
   OBJECT URLS
========================= */

function createObjectUrl(file) {
  const url =
    URL.createObjectURL(file);

  state.objectUrls.add(url);

  return url;
}

function revokeObjectUrls() {
  for (
    const url of state.objectUrls
  ) {
    URL.revokeObjectURL(url);
  }

  state.objectUrls.clear();
}

/* =========================
   STATS
========================= */

function updateStats() {
  const totalSize =
    state.items.reduce(
      (sum, item) =>
        sum + item.file.size,
      0
    );

  const packCount =
    state.items.length
      ? Math.ceil(
          state.items.length /
          state.packSize
        )
      : 0;

  $("statFiles").textContent =
    state.items.length;

  $("statSize").textContent =
    formatBytes(totalSize);

  $("statPackSize").textContent =
    state.packSize;

  $("statPacks").textContent =
    packCount;

  $("statCurrent").textContent =
    state.currentPack
      ? `${state.currentPack} / ${packCount}`
      : "–";

  $("statSent").textContent =
    `${state.sent} / ${state.items.length}`;

  sendBtn.disabled =
    state.items.length === 0 ||
    state.sending;

  clearBtn.disabled =
    state.items.length === 0 ||
    state.sending;
}

/* =========================
   PACK SIZE
========================= */

function renderPackButtons() {
  const container =
    $("packSizes");

  container.replaceChildren();

  for (
    const size of PACK_OPTIONS
  ) {
    const button =
      document.createElement(
        "button"
      );

    button.type = "button";

    button.textContent =
      size;

    button.className =
      size === state.packSize
        ? "active"
        : "";

    button.addEventListener(
      "click",
      () => {
        if (state.sending) return;

        state.packSize =
          size;

        renderPackButtons();
        renderPacks();
        updateStats();
      }
    );

    container.appendChild(
      button
    );
  }
}

/* =========================
   PREVIEWS
========================= */

function createPreviewBox(item) {
  const box =
    document.createElement(
      "div"
    );

  box.className =
    "media-card";

  box.dataset.previewId =
    item.id;

  const placeholder =
    document.createElement(
      "div"
    );

  placeholder.className =
    "preview-placeholder";

  placeholder.textContent =
    item.type === "video"
      ? "VIDEO"
      : "IMAGE";

  box.appendChild(
    placeholder
  );

  const badge =
    document.createElement(
      "div"
    );

  badge.className =
    "type-badge";

  badge.textContent =
    item.type === "video"
      ? "VIDEO"
      : "PHOTO";

  box.appendChild(
    badge
  );

  const name =
    document.createElement(
      "div"
    );

  name.className =
    "media-name";

  name.textContent =
    item.file.name;

  box.appendChild(
    name
  );

  return box;
}

function loadPreview(
  box,
  item
) {
  if (
    !box ||
    box.dataset.loaded ===
      "true"
  ) {
    return;
  }

  box.dataset.loaded =
    "true";

  const placeholder =
    box.querySelector(
      ".preview-placeholder"
    );

  const badge =
    box.querySelector(
      ".type-badge"
    );

  if (
    item.type === "image"
  ) {
    const img =
      new Image();

    img.alt =
      item.file.name;

    img.decoding =
      "async";

    img.onload = () => {
      placeholder?.remove();
    };

    img.onerror = () => {
      if (placeholder) {
        placeholder.textContent =
          "Preview unavailable";
      }
    };

    img.src =
      item.url;

    if (badge) {
      box.insertBefore(
        img,
        badge
      );
    } else {
      box.appendChild(
        img
      );
    }

    return;
  }

  const video =
    document.createElement(
      "video"
    );

  video.muted = true;
  video.playsInline = true;

  video.preload =
    "metadata";

  video.addEventListener(
    "loadeddata",
    () => {
      placeholder?.remove();
    },
    { once: true }
  );

  video.addEventListener(
    "error",
    () => {
      if (placeholder) {
        placeholder.textContent =
          "Preview unavailable";
      }
    },
    { once: true }
  );

  video.src =
    item.url;

  if (badge) {
    box.insertBefore(
      video,
      badge
    );
  } else {
    box.appendChild(
      video
    );
  }
}

function setupPreviewObserver() {
  if (
    state.previewObserver
  ) {
    state.previewObserver.disconnect();
  }

  if (
    !(
      "IntersectionObserver"
      in window
    )
  ) {
    document
      .querySelectorAll(
        ".media-card[data-preview-id]"
      )
      .forEach((box) => {
        const item =
          state.items.find(
            (x) =>
              x.id ===
              box.dataset.previewId
          );

        if (item) {
          loadPreview(
            box,
            item
          );
        }
      });

    return;
  }

  state.previewObserver =
    new IntersectionObserver(
      (
        entries,
        observer
      ) => {
        for (
          const entry of entries
        ) {
          if (
            !entry.isIntersecting
          ) {
            continue;
          }

          const box =
            entry.target;

          const item =
            state.items.find(
              (x) =>
                x.id ===
                box.dataset.previewId
            );

          if (item) {
            loadPreview(
              box,
              item
            );
          }

          observer.unobserve(
            box
          );
        }
      },
      {
        rootMargin:
          "300px 0px"
      }
    );

  document
    .querySelectorAll(
      ".media-card[data-preview-id]"
    )
    .forEach((box) =>
      state.previewObserver.observe(
        box
      )
    );
}

/* =========================
   PACK RENDERING
========================= */

function renderPacks() {
  if (
    state.previewObserver
  ) {
    state.previewObserver.disconnect();
  }

  packsEl.replaceChildren();

  if (!state.items.length) {
    return;
  }

  const packCount =
    Math.ceil(
      state.items.length /
      state.packSize
    );

  for (
    let i = 0;
    i < packCount;
    i++
  ) {
    const items =
      state.items.slice(
        i * state.packSize,
        (i + 1) *
          state.packSize
      );

    const pack =
      document.createElement(
        "article"
      );

    pack.className =
      "pack";

    const head =
      document.createElement(
        "div"
      );

    head.className =
      "pack-head";

    const title =
      document.createElement(
        "span"
      );

    title.className =
      "pack-title";

    title.textContent =
      `PACK ${i + 1}`;

    const status =
      document.createElement(
        "span"
      );

    status.className =
      "pack-status";

    status.textContent =
      `${items.length} FILE${
        items.length === 1
          ? ""
          : "S"
      }`;

    head.append(
      title,
      status
    );

    const itemsEl =
      document.createElement(
        "div"
      );

    itemsEl.className =
      "pack-items";

    for (
      const item of items
    ) {
      itemsEl.appendChild(
        createPreviewBox(
          item
        )
      );
    }

    pack.append(
      head,
      itemsEl
    );

    packsEl.appendChild(
      pack
    );
  }

  setupPreviewObserver();
}

/* =========================
   ADD FILES
========================= */

function addFiles(fileList) {
  if (state.sending) {
    return;
  }

  const files =
    Array.from(
      fileList || []
    );

  if (!files.length) {
    return;
  }

  const problems = [];

  for (
    const file of files
  ) {
    if (
      state.items.length >=
      MAX_FILES_TOTAL
    ) {
      problems.push(
        `Maximum of ${MAX_FILES_TOTAL} files reached.`
      );

      break;
    }

    if (
      !file.type.startsWith(
        "image/"
      ) &&
      !file.type.startsWith(
        "video/"
      )
    ) {
      problems.push(
        `${file.name}: unsupported file type.`
      );

      continue;
    }

    const maxMb =
      file.type.startsWith(
        "image/"
      )
        ? PHOTO_MAX_MB
        : MAX_FILE_MB;

    if (
      file.size >
      maxMb *
        1024 *
        1024
    ) {
      problems.push(
        `${file.name}: larger than ${maxMb} MB.`
      );

      continue;
    }

    state.items.push({
      id:
        crypto.randomUUID?.() ||
        `${Date.now()}-${Math.random()}`,

      file,

      type:
        file.type.startsWith(
          "video/"
        )
          ? "video"
          : "image",

      url:
        createObjectUrl(
          file
        )
    });
  }

  state.sent = 0;
  state.currentPack = 0;

  if (problems.length) {
    setMessage(
      "error",
      [
        "FILES SKIPPED",
        "",
        ...problems
      ].join("\n")
    );
  } else {
    setMessage(
      "",
      ""
    );
  }

  renderPacks();
  updateStats();
}

/* =========================
   CLEAR
========================= */

function clearAll() {
  if (state.sending) {
    return;
  }

  revokeObjectUrls();

  state.items = [];
  state.sent = 0;
  state.currentPack = 0;

  state.uploadLoaded = 0;
  state.uploadTotal = 0;

  renderPacks();
  updateStats();

  $("progressText").textContent =
    "Ready to upload.";

  $("progressPercent").textContent =
    "0%";

  $("barFill").style.width =
    "0%";

  setMessage(
    "",
    ""
  );
}

/* =========================
   PACKS
========================= */

function getPacks() {
  const packs = [];

  for (
    let i = 0;
    i < state.items.length;
    i += state.packSize
  ) {
    packs.push(
      state.items.slice(
        i,
        i + state.packSize
      )
    );
  }

  return packs;
}

function updatePackStatus(
  index,
  text
) {
  const packs =
    packsEl.querySelectorAll(
      ".pack"
    );

  const status =
    packs[index]?.querySelector(
      ".pack-status"
    );

  if (status) {
    status.textContent =
      text;
  }
}

/* =========================
   DETAILED ERRORS
========================= */

function getUploadError(
  xhr,
  packIndex,
  totalPacks,
  pack
) {
  let response =
    xhr.response;

  if (
    !response &&
    xhr.responseText
  ) {
    try {
      response =
        JSON.parse(
          xhr.responseText
        );
    } catch {
      response = null;
    }
  }

  const status =
    xhr.status;

  let serverMessage =
    response?.error ||
    response?.message ||
    response?.details ||
    response?.reason ||
    "";

  if (
    typeof serverMessage !==
    "string"
  ) {
    serverMessage =
      JSON.stringify(
        serverMessage
      );
  }

  if (
    !serverMessage &&
    xhr.responseText
  ) {
    serverMessage =
      xhr.responseText.trim();
  }

  if (!serverMessage) {
    serverMessage =
      "No message was returned by the server.";
  }

  const base = [
    "UPLOAD FAILED",
    "",
    `Pack: ${packIndex + 1} / ${totalPacks}`,
    `Files in pack: ${pack.length}`,
    `HTTP: ${status || "unknown"}`,
    ""
  ];

  if (status === 400) {
    return [
      ...base,
      "Server message:",
      serverMessage
    ].join("\n");
  }

  if (status === 401) {
    return [
      ...base,
      "Authentication failed.",
      "",
      "Server message:",
      serverMessage
    ].join("\n");
  }

  if (status === 403) {
    return [
      ...base,
      "The server rejected this request.",
      "",
      "Server message:",
      serverMessage
    ].join("\n");
  }

  if (status === 413) {
    return [
      ...base,
      "The upload is too large.",
      "",
      `Pack size: ${formatBytes(
        pack.reduce(
          (sum, item) =>
            sum + item.file.size,
          0
        )
      )}`,
      "",
      "Server message:",
      serverMessage
    ].join("\n");
  }

  if (status === 429) {
    return [
      ...base,
      "The server is rate limiting uploads.",
      "",
      "Wait a moment and try again.",
      "",
      "Server message:",
      serverMessage
    ].join("\n");
  }

  if (
    status === 500 ||
    status === 501
  ) {
    return [
      ...base,
      "The bot server returned an internal error.",
      "",
      "Server message:",
      serverMessage
    ].join("\n");
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return [
      ...base,
      "The bot server or proxy is unavailable.",
      "",
      "Check that the Raven Host server is running.",
      "",
      "Server message:",
      serverMessage
    ].join("\n");
  }

  return [
    ...base,
    "Server message:",
    serverMessage
  ].join("\n");
}

/* =========================
   SEND ONE PACK
========================= */

function sendPack(
  pack,
  packIndex,
  totalPacks
) {
  return new Promise(
    (resolve, reject) => {
      const form =
        new FormData();

      for (
        const item of pack
      ) {
        form.append(
          "files",
          item.file,
          item.file.name
        );
      }

      /*
       * IMPORTANT
       *
       * Always send the selected
       * pack size.
       *
       * If selected size = 10
       * and the final pack has 3 files,
       * we STILL send packSize=10.
       *
       * This prevents:
       *
       * "pack size must be an integer from 5-10"
       */

      form.append(
        "packSize",
        String(
          state.packSize
        )
      );

      form.append(
        "packIndex",
        String(
          packIndex + 1
        )
      );

      form.append(
        "totalPacks",
        String(
          totalPacks
        )
      );

      if (
        packIndex === 0
      ) {
        form.append(
          "caption",
          captionEl.value.trim()
        );
      }

      const xhr =
        new XMLHttpRequest();

      xhr.open(
        "POST",
        `${WORKER_URL}/api/send-media?packSize=${encodeURIComponent(
          state.packSize
        )}`
      );

      xhr.responseType =
        "json";

      xhr.timeout =
        10 * 60 * 1000;

      xhr._lastLoaded = 0;

      xhr.upload.onprogress =
        (event) => {
          if (
            !event.lengthComputable
          ) {
            return;
          }

          const difference =
            event.loaded -
            xhr._lastLoaded;

          state.uploadLoaded +=
            difference;

          xhr._lastLoaded =
            event.loaded;

          updateUploadProgress();
        };

      xhr.onload = () => {
        let response =
          xhr.response;

        if (
          !response &&
          xhr.responseText
        ) {
          try {
            response =
              JSON.parse(
                xhr.responseText
              );
          } catch {
            response = null;
          }
        }

        if (
          xhr.status >= 200 &&
          xhr.status < 300 &&
          response &&
          response.ok !== false
        ) {
          resolve(
            response
          );

          return;
        }

        reject(
          new Error(
            getUploadError(
              xhr,
              packIndex,
              totalPacks,
              pack
            )
          )
        );
      };

      xhr.onerror = () => {
        reject(
          new Error(
            [
              "NETWORK ERROR",
              "",
              `Pack: ${packIndex + 1} / ${totalPacks}`,
              `Files: ${pack.length}`,
              "",
              "The browser could not connect to the upload server.",
              "",
              "Check that the Raven Host server is online."
            ].join("\n")
          )
        );
      };

      xhr.ontimeout = () => {
        reject(
          new Error(
            [
              "UPLOAD TIMEOUT",
              "",
              `Pack: ${packIndex + 1} / ${totalPacks}`,
              `Files: ${pack.length}`,
              "",
              "The server took too long to respond.",
              "",
              "The upload was stopped."
            ].join("\n")
          )
        );
      };

      xhr.send(
        form
      );
    }
  );
}

/* =========================
   PROGRESS
========================= */

function updateUploadProgress() {
  if (
    !state.uploadTotal
  ) {
    return;
  }

  const percent =
    (
      state.uploadLoaded /
      state.uploadTotal
    ) * 100;

  const safe =
    Math.max(
      0,
      Math.min(
        100,
        percent
      )
    );

  const rounded =
    Math.round(safe);

  $("barFill").style.width =
    `${safe}%`;

  $("progressPercent").textContent =
    `${rounded}%`;

  $("progressText").textContent =
    `Uploading ${rounded}%`;
}

/* =========================
   SEND ALL
========================= */

async function sendAll() {
  if (
    state.sending ||
    !state.items.length
  ) {
    return;
  }

  state.sending =
    true;

  state.sent = 0;
  state.currentPack = 0;

  state.uploadLoaded = 0;

  const packs =
    getPacks();

  state.uploadTotal =
    state.items.reduce(
      (sum, item) =>
        sum + item.file.size,
      0
    );

  sendBtn.disabled =
    true;

  clearBtn.disabled =
    true;

  $("barFill").style.width =
    "0%";

  $("progressPercent").textContent =
    "0%";

  $("progressText").textContent =
    "Starting upload...";

  setMessage(
    "",
    ""
  );

  try {
    let nextPack = 0;

    async function worker() {
      while (true) {
        const index =
          nextPack++;

        if (
          index >=
          packs.length
        ) {
          return;
        }

        state.currentPack =
          index + 1;

        updateStats();

        updatePackStatus(
          index,
          "UPLOADING"
        );

        await sendPack(
          packs[index],
          index,
          packs.length
        );

        state.sent +=
          packs[index].length;

        updatePackStatus(
          index,
          "SENT"
        );

        updateStats();
      }
    }

    const workerCount =
      Math.min(
        CONCURRENT_UPLOADS,
        packs.length
      );

    await Promise.all(
      Array.from(
        {
          length:
            workerCount
        },
        () =>
          worker()
      )
    );

    $("barFill").style.width =
      "100%";

    $("progressPercent").textContent =
      "100%";

    $("progressText").textContent =
      `Uploaded ${state.sent} files`;

    setMessage(
      "success",
      [
        "UPLOAD COMPLETE",
        "",
        `${state.sent} files uploaded successfully.`
      ].join("\n")
    );
  } catch (error) {
    $("progressText").textContent =
      `Stopped after ${state.sent} files.`;

    setMessage(
      "error",
      error?.message ||
        "Unknown upload error."
    );
  } finally {
    state.sending =
      false;

    updateStats();
  }
}

/* =========================
   HEALTH
========================= */

async function checkHealth() {
  try {
    const response =
      await fetch(
        `${WORKER_URL}/api/health`,
        {
          cache:
            "no-store"
        }
      );

    if (!response.ok) {
      throw new Error();
    }

    setApiStatus(
      "ok",
      "ONLINE"
    );
  } catch {
    setApiStatus(
      "error",
      "OFFLINE"
    );
  }
}

/* =========================
   EVENTS
========================= */

$("pickImages").onclick =
  () =>
    imageInput.click();

$("pickVideos").onclick =
  () =>
    videoInput.click();

imageInput.onchange =
  () => {
    addFiles(
      imageInput.files
    );

    imageInput.value =
      "";
  };

videoInput.onchange =
  () => {
    addFiles(
      videoInput.files
    );

    videoInput.value =
      "";
  };

dropzone.ondragover =
  (event) => {
    event.preventDefault();

    dropzone.classList.add(
      "dragging"
    );
  };

dropzone.ondragleave =
  () => {
    dropzone.classList.remove(
      "dragging"
    );
  };

dropzone.ondrop =
  (event) => {
    event.preventDefault();

    dropzone.classList.remove(
      "dragging"
    );

    addFiles(
      event.dataTransfer.files
    );
  };

dropzone.onkeydown =
  (event) => {
    if (
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();

      imageInput.click();
    }
  };

sendBtn.onclick =
  sendAll;

clearBtn.onclick =
  clearAll;

window.addEventListener(
  "beforeunload",
  revokeObjectUrls
);

/* =========================
   START
========================= */

renderPackButtons();

updateStats();

checkHealth();

setInterval(
  checkHealth,
  30000
);
