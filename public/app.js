/* =====================================================================
   CONFIGURATION — EDIT THIS SECTION
   ===================================================================== */

// 1) Where the API lives.
//    ""  (empty) = same site. Correct when you deploy with `npx wrangler deploy` (default).
//    Only if the website is hosted somewhere else (e.g. Cloudflare Pages), put the Worker URL
//    here, with no trailing slash:  "https://YOUR-WORKER.workers.dev"
const WORKER_URL = "";

// 2) Limits (keep them in sync with your Worker / bot server settings).
const DEFAULT_PACK_SIZE = 10;  // 5–10
const MAX_FILES_TOTAL   = 500; // files you can queue in the browser
const MAX_FILE_MB       = 50;  // per file (Telegram bot upload limit)
const PHOTO_MAX_MB      = 10;  // Telegram photo limit
const MAX_REQUEST_MB    = 95;  // one pack = one request; Cloudflare allows 100 MB (Free/Pro)

/* ===================================================================== */

"use strict";
const MB = 1024 * 1024;
const PACK_SIZES = [5, 6, 7, 8, 9, 10];
const $ = (id) => document.getElementById(id);
const els = {
  api: $("apiStatus"), drop: $("dropzone"), imgIn: $("imageInput"), vidIn: $("videoInput"),
  files: $("statFiles"), size: $("statSize"), psize: $("statPackSize"), packsN: $("statPacks"),
  current: $("statCurrent"), sent: $("statSent"), sizes: $("packSizes"), caption: $("caption"),
  packs: $("packs"), bar: $("barFill"), progress: $("progressText"), msg: $("message"),
  send: $("sendBtn"), clear: $("clearBtn"),
};
const state = {
  items: [], packSize: PACK_SIZES.includes(DEFAULT_PACK_SIZE) ? DEFAULT_PACK_SIZE : 10,
  busy: false, nextId: 1, dragId: null, job: null,
};

const workerConfigured = () => WORKER_URL === "" || (/^https?:\/\//.test(WORKER_URL) && !WORKER_URL.includes("YOUR-WORKER"));
const apiBase = () => WORKER_URL.replace(/\/+$/, "");

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b >= 100 ? 0 : 1)} ${u[i]}`;
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const sum = (items) => items.reduce((s, i) => s + i.file.size, 0);

function setMessage(type, text) {
  els.msg.hidden = !text;
  els.msg.className = "message" + (type ? " " + type : "");
  els.msg.textContent = text || "";
}
function setApi(kind, text) { els.api.className = `pill pill-${kind}`; els.api.textContent = text; }

/* ---------- API health ---------- */
async function checkApi() {
  if (!workerConfigured()) return setApi("warn", "Set WORKER_URL in app.js");
  try {
    const r = await fetch(`${apiBase()}/api/health`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.ok) setApi("ok", "Connected");
    else if (d && d.worker) setApi("warn", "API up, bot server unreachable");
    else setApi("bad", "API error");
  } catch { setApi("bad", "API unreachable"); }
}

/* ---------- Adding / removing files ---------- */
function addFiles(list) {
  if (state.busy) return;
  state.job = null;
  const problems = [];
  for (const file of list) {
    const img = file.type.startsWith("image/"), vid = file.type.startsWith("video/");
    if (!img && !vid) { problems.push(`${file.name}: not an image or video`); continue; }
    if (file.size > MAX_FILE_MB * MB) { problems.push(`${file.name}: larger than ${MAX_FILE_MB} MB`); continue; }
    if (img && file.size > PHOTO_MAX_MB * MB) { problems.push(`${file.name}: images must be ${PHOTO_MAX_MB} MB or smaller`); continue; }
    if (state.items.length >= MAX_FILES_TOTAL) { problems.push(`Limit of ${MAX_FILES_TOTAL} files reached`); break; }
    if (state.items.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) continue;
    state.items.push({ id: state.nextId++, file, kind: img ? "image" : "video", url: URL.createObjectURL(file), thumb: null });
  }
  setMessage(problems.length ? "error" : "", problems.length ? "Some files were skipped:\n" + problems.slice(0, 8).join("\n") + (problems.length > 8 ? `\n…and ${problems.length - 8} more` : "") : "");
  render();
}
function dropItem(item) { URL.revokeObjectURL(item.url); state.items = state.items.filter((i) => i !== item); }
function removeItem(id) { const it = state.items.find((i) => i.id === id); if (it && !state.busy) { dropItem(it); render(); } }
function clearAll() { if (state.busy) return; [...state.items].forEach(dropItem); state.job = null; setMessage("", ""); setProgress(0, "Nothing is being sent."); render(); }
function moveItem(fromIdx, toIdx) {
  if (state.busy || fromIdx === toIdx || toIdx < 0 || toIdx >= state.items.length) return;
  const [it] = state.items.splice(fromIdx, 1); state.items.splice(toIdx, 0, it); render();
}

/* ---------- Rendering ---------- */
function thumbFor(item) {
  if (item.thumb) return item.thumb;
  const box = document.createElement("div"); box.className = "thumb";
  if (item.kind === "image") {
    const img = document.createElement("img"); img.src = item.url; img.alt = ""; img.loading = "lazy"; img.draggable = false; box.append(img);
  } else {
    const v = document.createElement("video"); v.src = item.url + "#t=0.1"; v.preload = "metadata"; v.muted = true; v.playsInline = true; v.draggable = false; box.append(v);
  }
  const b = document.createElement("span"); b.className = "badge"; b.textContent = item.kind === "image" ? "Image" : "Video"; box.append(b);
  return (item.thumb = box);
}
function toolBtn(label, text, disabled, fn) {
  const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = label; b.setAttribute("aria-label", label);
  b.disabled = disabled; b.addEventListener("click", fn); return b;
}
function renderCard(item, idx) {
  const card = document.createElement("div"); card.className = "card"; card.draggable = !state.busy;
  card.append(thumbFor(item));
  const meta = document.createElement("div"); meta.className = "meta";
  const n = document.createElement("div"); n.className = "name"; n.textContent = item.file.name; n.title = item.file.name;
  const s = document.createElement("div"); s.className = "size"; s.textContent = fmtSize(item.file.size);
  meta.append(n, s);
  const tools = document.createElement("div"); tools.className = "tools";
  tools.append(
    toolBtn("Move earlier", "◀", state.busy || idx === 0, () => moveItem(idx, idx - 1)),
    toolBtn("Move later", "▶", state.busy || idx === state.items.length - 1, () => moveItem(idx, idx + 1)),
    toolBtn("Remove file", "✕", state.busy, () => removeItem(item.id)),
  );
  card.append(meta, tools);
  card.addEventListener("dragstart", (e) => { state.dragId = item.id; e.dataTransfer.setData("text/plain", String(item.id)); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
  card.addEventListener("dragend", () => { state.dragId = null; card.classList.remove("dragging"); });
  card.addEventListener("dragover", (e) => { if (state.dragId !== null) e.preventDefault(); });
  card.addEventListener("drop", (e) => {
    if (state.dragId === null) return;
    e.preventDefault(); e.stopPropagation();
    const from = state.items.findIndex((i) => i.id === state.dragId), to = state.items.findIndex((i) => i.id === item.id);
    state.dragId = null; moveItem(from, to);
  });
  return card;
}
function render() {
  const n = state.items.length, packs = chunk(state.items, state.packSize);
  els.files.textContent = n; els.size.textContent = fmtSize(sum(state.items));
  els.psize.textContent = state.packSize; els.packsN.textContent = packs.length;
  els.current.textContent = state.job && state.busy ? `${state.job.pack} / ${state.job.totalPacks}` : "–";
  els.sent.textContent = state.job ? `${state.job.sent} / ${state.job.totalFiles}` : `0 / ${n}`;
  els.send.disabled = state.busy || n === 0; els.clear.disabled = state.busy || n === 0;
  els.caption.disabled = state.busy;

  els.sizes.replaceChildren(...PACK_SIZES.map((v) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = v; b.disabled = state.busy;
    b.setAttribute("aria-pressed", String(v === state.packSize));
    b.addEventListener("click", () => { state.packSize = v; render(); });
    return b;
  }));

  if (!n) {
    const p = document.createElement("p"); p.className = "muted empty"; p.textContent = "No files yet. Add images or videos above.";
    els.packs.replaceChildren(p); return;
  }
  els.packs.replaceChildren(...packs.map((pack, pi) => {
    const sec = document.createElement("div");
    sec.className = "pack" + (pi % 2 ? " alt" : "") + (state.busy && state.job && pi === 0 ? " active" : "");
    const head = document.createElement("div"); head.className = "pack-head";
    const a = document.createElement("span"); a.textContent = `Pack ${pi + 1}`;
    const b = document.createElement("span"); b.textContent = `${pack.length} file${pack.length > 1 ? "s" : ""}, ${fmtSize(sum(pack))}`;
    head.append(a, b);
    const grid = document.createElement("div"); grid.className = "grid";
    pack.forEach((it, k) => grid.append(renderCard(it, pi * state.packSize + k)));
    sec.append(head, grid); return sec;
  }));
}
function setProgress(pct, text) { els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`; els.progress.textContent = text; }

/* ---------- Upload ---------- */
function uploadPack(pack, caption, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("packSize", String(state.packSize));
    if (caption) fd.append("caption", caption);
    pack.forEach((it) => fd.append("files", it.file, it.file.name));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase()}/api/send-media?packSize=${state.packSize}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, false);
    xhr.upload.onload = () => onProgress(null, true);
    xhr.onerror = () => reject(new Error("Network error: could not reach the API."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.onload = () => {
      const d = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300 && d && d.ok) resolve(d);
      else reject(new Error((d && d.error) || `Server returned HTTP ${xhr.status}.`));
    };
    xhr.send(fd);
  });
}

async function send() {
  if (state.busy || !state.items.length) return;
  if (!workerConfigured()) return setMessage("error", "WORKER_URL in public/app.js is invalid. Use an empty string (same site) or your full Worker URL.");
  const caption = els.caption.value.trim();
  const packs = chunk([...state.items], state.packSize);
  const big = packs.findIndex((p) => sum(p) > MAX_REQUEST_MB * MB);
  if (big !== -1) return setMessage("error", `Pack ${big + 1} is ${fmtSize(sum(packs[big]))}, above the ${MAX_REQUEST_MB} MB per-request limit.\nChoose a smaller pack size or remove some large files.`);

  const totalBytes = sum(state.items);
  state.busy = true;
  state.job = { pack: 1, totalPacks: packs.length, sent: 0, totalFiles: state.items.length };
  setMessage("", ""); render();
  let doneBytes = 0;

  for (let i = 0; i < packs.length; i++) {
    const pack = packs[i], bytes = sum(pack);
    state.job.pack = i + 1; render();
    try {
      await uploadPack(pack, caption, (loaded, finished) => {
        const now = finished ? bytes : loaded;
        const label = finished ? "Telegram is processing" : "Uploading";
        setProgress(((doneBytes + now) / totalBytes) * 100, `${label} pack ${i + 1} of ${packs.length} · ${state.job.sent} / ${state.job.totalFiles} files sent`);
      });
    } catch (err) {
      state.busy = false; render();
      setProgress(((doneBytes) / totalBytes) * 100, `Stopped at pack ${i + 1} of ${packs.length} · ${state.job.sent} / ${state.job.totalFiles} files sent`);
      return setMessage("error", `${err.message}\n${state.job.sent} of ${state.job.totalFiles} files were sent. Sent files were removed from the list; press Send again to continue with the rest.`);
    }
    doneBytes += bytes; state.job.sent += pack.length;
    pack.forEach(dropItem);
  }
  state.busy = false; render();
  setProgress(100, `Done · ${state.job.sent} / ${state.job.totalFiles} files sent`);
  setMessage("ok", `Success: ${state.job.sent} files sent in ${state.job.totalPacks} pack${state.job.totalPacks > 1 ? "s" : ""}.`);
}

/* ---------- Events ---------- */
$("pickImages").addEventListener("click", () => els.imgIn.click());
$("pickVideos").addEventListener("click", () => els.vidIn.click());
for (const input of [els.imgIn, els.vidIn]) input.addEventListener("change", () => { addFiles([...input.files]); input.value = ""; });
els.send.addEventListener("click", send);
els.clear.addEventListener("click", clearAll);
els.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.imgIn.click(); } });

const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); els.drop.classList.add("over"); } });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) els.drop.classList.remove("over"); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); els.drop.classList.remove("over");
  if (!state.busy) addFiles([...e.dataTransfer.files]);
});
window.addEventListener("beforeunload", (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ""; } });

render();
checkApi();
setInterval(checkApi, 30000);
