"use strict";

const WORKER_URL = "";
const DEFAULT_PACK_SIZE = 10;

const MAX_FILES_TOTAL = 500;
const MAX_FILE_MB = 50;
const PHOTO_MAX_MB = 10;
const MAX_REQUEST_MB = 95;

const PACK_OPTIONS = [5, 10];

const state = {
  items: [],
  packSize: DEFAULT_PACK_SIZE,
  sending: false,
  sent: 0,
  currentPack: 0,
  objectUrls: new Set(),
  previewObserver: null
};

const $ = (id) => document.getElementById(id);

const dropzone = $("dropzone");
const imageInput = $("imageInput");
const videoInput = $("videoInput");
const packsEl = $("packs");
const sendBtn = $("sendBtn");
const clearBtn = $("clearBtn");
const captionEl = $("caption");
const apiStatus = $("apiStatus");

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  return `${(bytes / Math.pow(1024, index)).toFixed(
    index === 0 ? 0 : 1
  )} ${units[index]}`;
}

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
  el.className = `message ${type || ""}`;
}

function setApiStatus(type, text) {
  apiStatus.textContent = text;
  apiStatus.className = `pill pill-${type}`;
}

function createObjectUrl(file) {
  const url = URL.createObjectURL(file);
  state.objectUrls.add(url);
  return url;
}

function revokeObjectUrls() {
  for (const url of state.objectUrls) {
    URL.revokeObjectURL(url);
  }

  state.objectUrls.clear();
}

function updateStats() {
  const totalSize = state.items.reduce(
    (sum, item) => sum + item.file.size,
    0
  );

  const packCount = state.items.length
    ? Math.ceil(state.items.length / state.packSize)
    : 0;

  $("statFiles").textContent = state.items.length;
  $("statSize").textContent = formatBytes(totalSize);
  $("statPackSize").textContent = state.packSize;
  $("statPacks").textContent = packCount;
  $("statCurrent").textContent = state.currentPack
    ? `${state.currentPack} / ${packCount}`
    : "–";
  $("statSent").textContent = `${state.sent} / ${state.items.length}`;

  sendBtn.disabled = state.items.length === 0 || state.sending;
  clearBtn.disabled = state.items.length === 0 || state.sending;
}

function createPackButton(size) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = size;
  button.className = size === state.packSize ? "active" : "";

  button.addEventListener("click", () => {
    if (state.sending) return;

    state.packSize = size;
    renderPackButtons();
    renderPacks();
    updateStats();
  });

  return button;
}

function renderPackButtons() {
  const container = $("packSizes");
  container.replaceChildren();

  for (const size of PACK_OPTIONS) {
    container.appendChild(createPackButton(size));
  }
}

function createPreviewBox(item) {
  const box = document.createElement("div");
  box.className = "media-card";
  box.dataset.previewId = item.id;

  const placeholder = document.createElement("div");
  placeholder.className = "preview-placeholder";
  placeholder.textContent = item.type === "video"
    ? "Video"
    : "Image";

  box.appendChild(placeholder);

  const badge = document.createElement("div");
  badge.className = "type-badge";
  badge.textContent = item.type === "video" ? "VIDEO" : "PHOTO";

  box.appendChild(badge);

  const name = document.createElement("div");
  name.className = "media-name";
  name.textContent = item.file.name;

  box.appendChild(name);

  return box;
}

function loadPreview(box, item) {
  if (!box || box.dataset.loaded === "true") return;

  box.dataset.loaded = "true";

  const placeholder = box.querySelector(".preview-placeholder");
  const badge = box.querySelector(".type-badge");

  if (item.type === "image") {
    const img = new Image();

    img.alt = item.file.name;
    img.decoding = "async";
    img.loading = "lazy";

    img.onload = () => {
      placeholder?.remove();
    };

    img.onerror = () => {
      if (placeholder) {
        placeholder.textContent = "Preview unavailable";
      }
    };

    img.src = item.url;

    if (badge) {
      box.insertBefore(img, badge);
    } else {
      box.appendChild(img);
    }

    return;
  }

  const video = document.createElement("video");

  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

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
        placeholder.textContent = "Preview unavailable";
      }
    },
    { once: true }
  );

  video.src = item.url;
  video.currentTime = 0.1;

  if (badge) {
    box.insertBefore(video, badge);
  } else {
    box.appendChild(video);
  }
}

function setupPreviewObserver() {
  if (state.previewObserver) {
    state.previewObserver.disconnect();
  }

  if (!("IntersectionObserver" in window)) {
    document
      .querySelectorAll(".media-card[data-preview-id]")
      .forEach((box) => {
        const item = state.items.find(
          (entry) => entry.id === box.dataset.previewId
        );

        if (item) {
          loadPreview(box, item);
        }
      });

    return;
  }

  state.previewObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const box = entry.target;

        const item = state.items.find(
          (entryItem) => entryItem.id === box.dataset.previewId
        );

        if (item) {
          loadPreview(box, item);
        }

        observer.unobserve(box);
      }
    },
    {
      rootMargin: "300px 0px"
    }
  );

  document
    .querySelectorAll(".media-card[data-preview-id]")
    .forEach((box) => state.previewObserver.observe(box));
}

function renderPacks() {
  if (state.previewObserver) {
    state.previewObserver.disconnect();
  }

  packsEl.replaceChildren();

  if (!state.items.length) {
    return;
  }

  const packCount = Math.ceil(
    state.items.length / state.packSize
  );

  for (let packIndex = 0; packIndex < packCount; packIndex++) {
    const start = packIndex * state.packSize;
    const items = state.items.slice(
      start,
      start + state.packSize
    );

    const pack = document.createElement("article");
    pack.className = "pack";

    const head = document.createElement("div");
    head.className = "pack-head";

    const title = document.createElement("span");
    title.className = "pack-title";
    title.textContent = `Pack ${packIndex + 1}`;

    const status = document.createElement("span");
    status.className = "pack-status";
    status.textContent = `${items.length} file${
      items.length === 1 ? "" : "s"
    }`;

    head.appendChild(title);
    head.appendChild(status);

    const itemsEl = document.createElement("div");
    itemsEl.className = "pack-items";

    for (const item of items) {
      itemsEl.appendChild(createPreviewBox(item));
    }

    pack.appendChild(head);
    pack.appendChild(itemsEl);
    packsEl.appendChild(pack);
  }

  setupPreviewObserver();
}

function isAllowedFile(file) {
  return (
    file &&
    (
      file.type.startsWith("image/") ||
      file.type.startsWith("video/")
    )
  );
}

function addFiles(fileList) {
  if (state.sending) return;

  const files = Array.from(fileList || []);

  if (!files.length) return;

  const problems = [];

  for (const file of files) {
    if (state.items.length >= MAX_FILES_TOTAL) {
      problems.push(`Maximum of ${MAX_FILES_TOTAL} files reached.`);
      break;
    }

    if (!isAllowedFile(file)) {
      problems.push(`${file.name}: unsupported file type.`);
      continue;
    }

    const maxMb = file.type.startsWith("image/")
      ? PHOTO_MAX_MB
      : MAX_FILE_MB;

    if (file.size > maxMb * 1024 * 1024) {
      problems.push(
        `${file.name}: larger than ${maxMb} MB.`
      );
      continue;
    }

    const item = {
      id: crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
      file,
      type: file.type.startsWith("video/")
        ? "video"
        : "image",
      url: createObjectUrl(file)
    };

    state.items.push(item);
  }

  if (problems.length) {
    setMessage(
      "error",
      `Some files were skipped:\n${problems.join("\n")}`
    );
  } else {
    setMessage("", "");
  }

  state.sent = 0;
  state.currentPack = 0;

  renderPacks();
  updateStats();
}

function clearAll() {
  if (state.sending) return;

  revokeObjectUrls();

  state.items = [];
  state.sent = 0;
  state.currentPack = 0;

  renderPacks();
  updateStats();

  $("progressText").textContent =
    "Nothing is being sent.";

  $("barFill").style.width = "0%";

  setMessage("", "");
}

function getPacks() {
  const packs = [];

  for (
    let i = 0;
    i < state.items.length;
    i += state.packSize
  ) {
    packs.push(
      state.items.slice(i, i + state.packSize)
    );
  }

  return packs;
}

function updatePackStatus(packIndex, text) {
  const packs = packsEl.querySelectorAll(".pack");

  if (packs[packIndex]) {
    const status =
      packs[packIndex].querySelector(".pack-status");

    if (status) {
      status.textContent = text;
    }
  }
}

function sendPack(pack, packIndex, totalPacks) {
  return new Promise((resolve, reject) => {
    const form = new FormData();

    for (const item of pack) {
      form.append("files", item.file, item.file.name);
    }

    form.append("packSize", String(pack.length));
    form.append("packIndex", String(packIndex + 1));
    form.append("totalPacks", String(totalPacks));

    if (packIndex === 0 || captionEl.value.trim()) {
      form.append("caption", captionEl.value.trim());
    }

    const xhr = new XMLHttpRequest();

    xhr.open(
      "POST",
      `${WORKER_URL}/api/send-media?packSize=${encodeURIComponent(
        pack.length
      )}`
    );

    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;

      const packProgress =
        event.loaded / event.total;

      const completedBefore = packIndex * state.packSize;

      const overall =
        (
          (completedBefore +
            packProgress * pack.length) /
          state.items.length
        ) * 100;

      $("barFill").style.width =
        `${Math.min(100, overall)}%`;

      $("progressText").textContent =
        `Sending pack ${packIndex + 1} of ${totalPacks}…`;
    };

    xhr.onload = () => {
      let response = xhr.response;

      if (!response && xhr.responseText) {
        try {
          response = JSON.parse(xhr.responseText);
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
        resolve(response);
        return;
      }

      reject(
        new Error(
          response?.error ||
          response?.message ||
          `Server returned HTTP ${xhr.status}`
        )
      );
    };

    xhr.onerror = () => {
      reject(new Error("Network error while sending."));
    };

    xhr.ontimeout = () => {
      reject(new Error("Request timed out."));
    };

    xhr.timeout = 10 * 60 * 1000;

    xhr.send(form);
  });
}

async function sendAll() {
  if (
    state.sending ||
    !state.items.length
  ) {
    return;
  }

  state.sending = true;
  state.sent = 0;
  state.currentPack = 0;

  sendBtn.disabled = true;
  clearBtn.disabled = true;

  setMessage("", "");

  const packs = getPacks();

  try {
    for (
      let index = 0;
      index < packs.length;
      index++
    ) {
      state.currentPack = index + 1;

      updateStats();
      updatePackStatus(
        index,
        "Sending…"
      );

      await sendPack(
        packs[index],
        index,
        packs.length
      );

      state.sent += packs[index].length;

      updatePackStatus(
        index,
        "Sent"
      );

      updateStats();

      const progress =
        (state.sent / state.items.length) * 100;

      $("barFill").style.width =
        `${progress}%`;
    }

    $("progressText").textContent =
      `Sent ${state.sent} files successfully.`;

    setMessage(
      "success",
      "All files were sent successfully."
    );
  } catch (error) {
    $("progressText").textContent =
      `Stopped after ${state.sent} files.`;

    setMessage(
      "error",
      error?.message ||
        "Something went wrong while sending."
    );
  } finally {
    state.sending = false;
    updateStats();
  }
}

async function checkHealth() {
  try {
    const response = await fetch(
      `${WORKER_URL}/api/health`,
      {
        method: "GET",
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error();
    }

    setApiStatus("ok", "Online");
  } catch {
    setApiStatus("error", "Offline");
  }
}

$("pickImages").addEventListener(
  "click",
  () => imageInput.click()
);

$("pickVideos").addEventListener(
  "click",
  () => videoInput.click()
);

imageInput.addEventListener(
  "change",
  () => {
    addFiles(imageInput.files);
    imageInput.value = "";
  }
);

videoInput.addEventListener(
  "change",
  () => {
    addFiles(videoInput.files);
    videoInput.value = "";
  }
);

dropzone.addEventListener(
  "dragover",
  (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  }
);

dropzone.addEventListener(
  "dragleave",
  () => {
    dropzone.classList.remove("dragging");
  }
);

dropzone.addEventListener(
  "drop",
  (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");

    addFiles(event.dataTransfer.files);
  }
);

dropzone.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      imageInput.click();
    }
  }
);

sendBtn.addEventListener(
  "click",
  sendAll
);

clearBtn.addEventListener(
  "click",
  clearAll
);

window.addEventListener(
  "beforeunload",
  revokeObjectUrls
);

renderPackButtons();
updateStats();
checkHealth();

setInterval(
  checkHealth,
  30000
);
