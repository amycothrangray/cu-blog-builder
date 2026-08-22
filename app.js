/* Christian Unified Blog Builder — builds a real photo blog post and publishes
   it to christianunified.org. Same app as the Amy Gray Photography builder,
   pointed at the school and without the family-session photo analysis: one
   passphrase, then drag in photos, paste the words, press ✨, press Publish. */
'use strict';

const BACKEND = 'https://dolphin-app-f4t5q.ondigitalocean.app';
const API = '/api/cu/blog';   // the school's routes on the shared backend
const SITE = 'https://christianunified.org';
const SITE_HOST = 'christianunified.org';
const ORG = 'Christian Unified Schools of San Diego';
const MAX_EDGE = 1800;      // long edge of published photos
const THUMB_EDGE = 420;     // tray thumbnails (also sent to the AI)
const JPEG_Q = 0.82;
/* Credit + copyright stamped inside every published photo. Defaults to the
   school; a post shot by an outside photographer overrides it in step 1. */
const DEFAULT_CREDIT = ORG;
const creditOf = () => ((state && state.credit) || '').trim() || DEFAULT_CREDIT;
const rightsOf = () => `© ${new Date().getFullYear()} ${creditOf()}. All rights reserved.`;

/* Keywords the school wants to rank for — what a parent actually types when
   they are shopping for a school. Editable in the app; kept in this browser.
   Deliberately short (2-5 words): the SEO scorecard looks for the focus keyword
   verbatim in the title, slug, meta, first paragraph and alt text, and a long
   phrase can never pass those checks. Money terms first. Everything here is
   something the school can honestly claim — no accreditation terms, because
   none are stated on the site. */
const DEFAULT_KEYWORDS = [
  // Geography + type: real search volume, real intent.
  'Christian school San Diego',
  'Christian school El Cajon',
  'private school El Cajon',
  'Christian school Chula Vista',
  'private school Chula Vista',
  'private schools San Diego',
  'East County private school',
  // By level — highest intent, because the parent already knows the age.
  'Christian high school San Diego',
  'Christian junior high San Diego',
  'Christian elementary school San Diego',
  'TK and kindergarten San Diego',
  // Distinctives, in the school's own words (Vision & Mission page).
  'college preparatory Christian school',
  'biblical worldview education',
  'best private schools in San Diego',
  // What blog posts are actually about, so a story can earn one honestly.
  'Christian school athletics San Diego',
  'Christian school arts program',
  'Christian school student life',
  // Brand terms — cheap to win, and they convert.
  'Christian Unified Schools',
  'Christian High School Patriots',
];
function getKeywords() {
  try {
    const saved = JSON.parse(localStorage.getItem('cuKeywords') || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* fall through to defaults */ }
  return DEFAULT_KEYWORDS.slice();
}
function setKeywords(list) { localStorage.setItem('cuKeywords', JSON.stringify(list)); }

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => String(s ?? '').toLowerCase()
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/* WordPress returns titles HTML-encoded ("Field &amp; Park"); show them as text. */
const decode = (s) => {
  const el = document.createElement('textarea');
  el.innerHTML = String(s ?? '');
  return el.value;
};

/* ------------------------------------------------------------------ state */
let state = null;
let siteData = { categories: [], posts: [], pages: [] };
let slugTouched = false;

function freshState() {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(), updatedAt: Date.now(),
    title: '', slug: '', location: '', credit: '', categories: [],
    sourceFacts: null,
    metaDesc: '', focusKeyword: '', excerpt: '', secondaryKeywords: [],
    photos: {}, photoOrder: [],
    blocks: [],
    links: { internal: [], external: [] },
    inlineLinks: [],
    featuredPid: null,
    publishedUrl: '',
    when: 'now', whenAt: '',
  };
}

/* -------------------------------------------------------------- IndexedDB */
let db = null;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cu-blog-builder', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode);
    const out = fn(tx.objectStore('drafts'));
    tx.oncomplete = () => resolve(out && out.result);
    tx.onerror = () => reject(tx.error);
  });
}

let saveTimer = null;
function touch() {
  state.updatedAt = Date.now();
  $('saveState').textContent = 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await idb('readwrite', (s) => s.put(JSON.parse(JSON.stringify(state))));
    localStorage.setItem('cuBlogLastDraft', state.id);
    $('saveState').textContent = 'saved';
  }, 700);
}

/* ------------------------------------------------------------------- gate */
function apiHeaders() {
  return { 'X-CU-Key': localStorage.getItem('cuBlogKey') || '', 'Content-Type': 'application/json' };
}
async function api(path, opts = {}) {
  const r = await fetch(BACKEND + path, { ...opts, headers: { ...apiHeaders(), ...(opts.headers || {}) } });
  if (r.status === 401) { showGate(); throw new Error('unauthorized'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('request failed (' + r.status + ')'));
  return body;
}
function showGate() { $('gate').classList.remove('hidden'); $('gateInput').focus(); }
async function tryGate() {
  // macOS/iOS substitute typed hyphens with en/em dashes and quotes with curly
  // ones; fold them back so a correctly-typed passphrase isn't rejected.
  const key = $('gateInput').value.trim()
    .replace(/[‐-―]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  if (!key) return;
  localStorage.setItem('cuBlogKey', key);
  $('gateError').classList.add('hidden');
  $('gateBtn').disabled = true;
  try {
    await loadSite(true);
    $('gate').classList.add('hidden');
  } catch (e) {
    // Only a 401 means the passphrase is actually wrong; anything else is the
    // server being unreachable (e.g. mid-redeploy) and the passphrase is fine.
    const wrongKey = e && e.message === 'unauthorized';
    if (wrongKey) localStorage.removeItem('cuBlogKey');
    $('gateError').textContent = wrongKey
      ? 'That passphrase didn\'t work — double-check with Amy.'
      : 'The passphrase looks fine, but the server didn\'t answer just now. Wait a minute and press the button again.';
    $('gateError').classList.remove('hidden');
  }
  $('gateBtn').disabled = false;
}

/* -------------------------------------------------------------- site data */
async function loadSite(throwOnFail) {
  try {
    siteData = await api(API + '/site');
    renderCats();
    renderLinkResults();
    const pick = $('ilPagePick');
    if (pick) {
      pick.innerHTML = '<option value="">— or link to a page on the school site —</option>';
      [...siteData.pages, ...siteData.posts]
        .sort((a, b) => linkRank(a.title) - linkRank(b.title))
        .slice(0, 80).forEach((p) => {
        const o = document.createElement('option');
        o.value = p.url; o.textContent = decode(p.title);
        pick.appendChild(o);
      });
    }
  } catch (e) {
    if (throwOnFail) throw e;
    $('catChips').innerHTML = '<span class="hint">Couldn\'t reach the website — categories will load when the connection is back.</span>';
  }
}
function renderCats() {
  const box = $('catChips');
  box.innerHTML = '';
  siteData.categories.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'chip' + (state.categories.includes(c.id) ? ' on' : '');
    b.textContent = decode(c.name);
    b.onclick = () => {
      const i = state.categories.indexOf(c.id);
      if (i >= 0) state.categories.splice(i, 1); else state.categories.push(c.id);
      b.classList.toggle('on');
      touch();
    };
    box.appendChild(b);
  });
}

/* ------------------------------------------------------- photo metadata
   Resizing on a canvas throws away the EXIF/IPTC/XMP the camera and Lightroom
   wrote, so published files would carry no credit at all. Rebuild an XMP packet
   (creator, copyright, caption, keywords) and splice it in as an APP1 segment
   right after the SOI marker. Google reads this for image credit and licensing. */
function xmpPacket({ description, keywords }) {
  const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const kw = (keywords || []).map((k) => `<rdf:li>${x(k)}</rdf:li>`).join('');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:plus="http://ns.useplus.org/ldf/xmp/1.0/">
<dc:creator><rdf:Seq><rdf:li>${x(creditOf())}</rdf:li></rdf:Seq></dc:creator>
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${x(rightsOf())}</rdf:li></rdf:Alt></dc:rights>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${x(description)}</rdf:li></rdf:Alt></dc:description>
<dc:subject><rdf:Bag>${kw}</rdf:Bag></dc:subject>
<photoshop:Credit>${x(creditOf())}</photoshop:Credit>
<photoshop:Source>${x(SITE)}</photoshop:Source>
<xmpRights:Marked>True</xmpRights:Marked>
<xmpRights:WebStatement>${x(SITE)}</xmpRights:WebStatement>
<xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang="x-default">${x(rightsOf())}</rdf:li></rdf:Alt></xmpRights:UsageTerms>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
}

/* Insert the XMP packet into a JPEG given as a data URL; returns a new data URL.
   Returns the original untouched if anything looks unexpected. */
function embedXmp(dataUrl, fields) {
  try {
    const comma = dataUrl.indexOf(',');
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return dataUrl; // not a JPEG
    const header = 'http://ns.adobe.com/xap/1.0/\0';
    const xmp = xmpPacket(fields);
    const payload = new TextEncoder().encode(header + xmp);
    const segLen = payload.length + 2;
    if (segLen > 0xFFFF) return dataUrl; // too big for one APP1 segment
    const out = new Uint8Array(bytes.length + segLen + 2);
    out.set(bytes.subarray(0, 2), 0);                 // SOI
    out[2] = 0xFF; out[3] = 0xE1;                     // APP1 marker
    out[4] = (segLen >> 8) & 0xFF; out[5] = segLen & 0xFF;
    out.set(payload, 6);
    out.set(bytes.subarray(2), 6 + payload.length);   // rest of the original
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < out.length; i += CH) s += String.fromCharCode.apply(null, out.subarray(i, i + CH));
    return 'data:image/jpeg;base64,' + btoa(s);
  } catch {
    return dataUrl;
  }
}


/* ---------------------------------------------------------------- cropping
   Crops are non-destructive: the untouched resized file is kept as `origFull`
   the first time a crop is applied, and every later crop is recomputed from it,
   so you can re-crop or reset without losing quality. */
const CROP_RATIOS = [
  { id: 'free', label: 'Free', r: null },
  { id: 'square', label: 'Square 1:1', r: 1 },
  { id: 'p45', label: 'Portrait 4:5', r: 4 / 5 },
  { id: 'p23', label: 'Portrait 2:3', r: 2 / 3 },
  { id: 'l32', label: 'Landscape 3:2', r: 3 / 2 },
  { id: 'l169', label: 'Wide 16:9', r: 16 / 9 },
];
let cropPid = null;
let cropBox = null;      // fractions of the source image: {x, y, w, h}
let cropRatio = null;    // null = free
let cropImg = null;      // the source Image element

function sourceOf(pid) {
  const p = state.photos[pid];
  return p.origFull || p.full;
}

function openCrop(pid) {
  cropPid = pid;
  const p = state.photos[pid];
  cropImg = new Image();
  cropImg.onload = () => {
    const existing = p.crop;
    cropRatio = p.cropRatio != null ? p.cropRatio : null;
    cropBox = existing ? { ...existing } : { x: 0, y: 0, w: 1, h: 1 };
    renderRatioButtons();
    // Show it first — the stage has no measurable size while it is hidden,
    // which would place the crop box at zero width. Force a reflow and draw
    // synchronously; requestAnimationFrame can be deferred by the browser.
    $('cropModal').classList.remove('hidden');
    void $('cropStage').offsetWidth;
    drawCrop();
    setTimeout(drawCrop, 50);   // catch late font/layout shifts
  };
  cropImg.src = sourceOf(pid);
}

function renderRatioButtons() {
  const box = $('cropRatios');
  box.innerHTML = '';
  CROP_RATIOS.forEach((opt) => {
    const b = document.createElement('button');
    const on = (opt.r === null && cropRatio === null) ||
               (opt.r !== null && cropRatio !== null && Math.abs(opt.r - cropRatio) < 0.001);
    b.className = 'chip' + (on ? ' on' : '');
    b.textContent = opt.label;
    b.onclick = () => { cropRatio = opt.r; applyRatio(); renderRatioButtons(); drawCrop(); };
    box.appendChild(b);
  });
}

/* Reshape the current box to the chosen ratio, keeping it centred and inside. */
function applyRatio() {
  if (cropRatio === null || !cropImg) return;
  const iw = cropImg.naturalWidth, ih = cropImg.naturalHeight;
  const cx = cropBox.x + cropBox.w / 2, cy = cropBox.y + cropBox.h / 2;
  // Work in pixels so the ratio is true regardless of the image's own shape.
  let wPx = cropBox.w * iw, hPx = cropBox.h * ih;
  if (wPx / hPx > cropRatio) wPx = hPx * cropRatio; else hPx = wPx / cropRatio;
  let w = wPx / iw, h = hPx / ih;
  // Grow to fill if the box got small, then clamp inside the image.
  const scale = Math.min(1 / w, 1 / h, 1.6);
  w *= scale; h *= scale;
  if (w > 1) { h *= 1 / w; w = 1; }
  if (h > 1) { w *= 1 / h; h = 1; }
  cropBox = {
    w, h,
    x: Math.min(Math.max(cx - w / 2, 0), 1 - w),
    y: Math.min(Math.max(cy - h / 2, 0), 1 - h),
  };
}

function drawCrop() {
  const stage = $('cropStage');
  const img = $('cropImg');
  img.src = cropImg.src;
  const box = $('cropBox');
  // Fit the image inside the stage, then place the box over it.
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const iw = cropImg.naturalWidth, ih = cropImg.naturalHeight;
  if (!sw || !sh || !iw || !ih) return;   // nothing measurable yet
  const scale = Math.min(sw / iw, sh / ih);
  const dw = iw * scale, dh = ih * scale;
  const ox = (sw - dw) / 2, oy = (sh - dh) / 2;
  img.style.width = dw + 'px'; img.style.height = dh + 'px';
  img.style.left = ox + 'px'; img.style.top = oy + 'px';
  box.style.left = (ox + cropBox.x * dw) + 'px';
  box.style.top = (oy + cropBox.y * dh) + 'px';
  box.style.width = (cropBox.w * dw) + 'px';
  box.style.height = (cropBox.h * dh) + 'px';
  stage.dataset.ox = ox; stage.dataset.oy = oy;
  stage.dataset.dw = dw; stage.dataset.dh = dh;
  const px = Math.round(cropBox.w * iw), py = Math.round(cropBox.h * ih);
  $('cropSize').textContent = `${px} × ${py} px`;
}

/* Pointer handling: drag the middle to move, a corner to resize. */
function startCropDrag(e, mode) {
  e.preventDefault();
  const stage = $('cropStage');
  const dw = +stage.dataset.dw, dh = +stage.dataset.dh;
  const startX = e.clientX, startY = e.clientY;
  const start = { ...cropBox };
  const iw = cropImg.naturalWidth, ih = cropImg.naturalHeight;

  const move = (ev) => {
    const fx = (ev.clientX - startX) / dw;
    const fy = (ev.clientY - startY) / dh;
    if (mode === 'move') {
      cropBox.x = Math.min(Math.max(start.x + fx, 0), 1 - start.w);
      cropBox.y = Math.min(Math.max(start.y + fy, 0), 1 - start.h);
    } else {
      let { x, y, w, h } = start;
      if (mode.includes('e')) w = start.w + fx;
      if (mode.includes('s')) h = start.h + fy;
      if (mode.includes('w')) { w = start.w - fx; x = start.x + fx; }
      if (mode.includes('n')) { h = start.h - fy; y = start.y + fy; }
      const minW = 40 / dw, minH = 40 / dh;
      w = Math.max(w, minW); h = Math.max(h, minH);
      if (cropRatio !== null) {
        // Keep the locked ratio, driven by whichever edge moved most.
        const wPx = w * iw, hPx = h * ih;
        if (Math.abs(fx) > Math.abs(fy)) h = (wPx / cropRatio) / ih;
        else w = (hPx * cropRatio) / iw;
        if (mode.includes('w')) x = start.x + start.w - w;
        if (mode.includes('n')) y = start.y + start.h - h;
      }
      // Clamp inside the image.
      x = Math.min(Math.max(x, 0), 1 - Math.min(w, 1));
      y = Math.min(Math.max(y, 0), 1 - Math.min(h, 1));
      w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
      cropBox = { x, y, w, h };
    }
    drawCrop();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* Render the crop into new full/thumb images for one photo. */
function renderCrop(pid, box, ratioUsed) {
  return new Promise((resolve) => {
    const p = state.photos[pid];
    const img = new Image();
    img.onload = () => {
      if (!p.origFull) p.origFull = p.full;      // keep the untouched original
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const sx = Math.round(box.x * iw), sy = Math.round(box.y * ih);
      const sw = Math.max(1, Math.round(box.w * iw)), sh = Math.max(1, Math.round(box.h * ih));
      const make = (edge, q) => {
        const sc = Math.min(1, edge / Math.max(sw, sh));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(sw * sc));
        c.height = Math.max(1, Math.round(sh * sc));
        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        return { url: c.toDataURL('image/jpeg', q), w: c.width, h: c.height };
      };
      const full = make(MAX_EDGE, JPEG_Q);
      const thumb = make(THUMB_EDGE, 0.75);
      p.full = full.url; p.w = full.w; p.h = full.h;
      p.thumb = thumb.url;
      p.crop = { ...box };
      p.cropRatio = ratioUsed;
      p.mediaId = null; p.mediaUrl = null;   // must be re-uploaded once cropped
      resolve();
    };
    img.src = sourceOf(pid);
  });
}

async function applyCrop() {
  if (!cropPid) return;
  $('cropApply').disabled = true;
  await renderCrop(cropPid, cropBox, cropRatio);
  $('cropApply').disabled = false;
  $('cropModal').classList.add('hidden');
  renderTray(); renderBlocks(); touch();
}

function resetCrop() {
  const p = state.photos[cropPid];
  if (p.origFull) {
    p.full = p.origFull;
    delete p.origFull;
  }
  delete p.crop; delete p.cropRatio;
  const img = new Image();
  img.onload = () => {
    p.w = img.naturalWidth; p.h = img.naturalHeight;
    const c = document.createElement('canvas');
    const sc = Math.min(1, THUMB_EDGE / Math.max(p.w, p.h));
    c.width = Math.round(p.w * sc); c.height = Math.round(p.h * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    p.thumb = c.toDataURL('image/jpeg', 0.75);
    p.mediaId = null; p.mediaUrl = null;
    $('cropModal').classList.add('hidden');
    renderTray(); renderBlocks(); touch();
  };
  img.src = p.full;
}

/* Square off one row at a time — Amy lays out a diptych, triptych or a row of
   four as squares, rather than squaring a whole post. Toggles back. */
async function centreSquare(pid) {
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.src = sourceOf(pid); });
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const side = Math.min(iw, ih);
  await renderCrop(pid, {
    x: (iw - side) / 2 / iw, y: (ih - side) / 2 / ih, w: side / iw, h: side / ih,
  }, 1);
}

async function restorePhoto(pid) {
  const p = state.photos[pid];
  if (!p.origFull) return;
  p.full = p.origFull;
  delete p.origFull; delete p.crop; delete p.cropRatio;
  p.mediaId = null; p.mediaUrl = null;
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.src = p.full; });
  p.w = img.naturalWidth; p.h = img.naturalHeight;
  const c = document.createElement('canvas');
  const sc = Math.min(1, THUMB_EDGE / Math.max(p.w, p.h));
  c.width = Math.round(p.w * sc); c.height = Math.round(p.h * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  p.thumb = c.toDataURL('image/jpeg', 0.75);
}

/* Shuffle the photos inside one row. Always lands on a different order. */
function mixRow(block) {
  const filled = block.slots.filter(Boolean);
  if (filled.length < 2) { layoutNote('That row needs at least two photos to mix.'); return; }
  const next = filled.slice();
  if (next.length === 2) {
    next.reverse();
  } else {
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    // A shuffle can land back where it started; nudge it so the click always shows.
    if (next.every((pid, i) => pid === filled[i])) next.push(next.shift());
  }
  const empties = block.slots.length - next.length;
  block.slots = next.concat(new Array(Math.max(0, empties)).fill(null));
  renderBlocks(); renderTray(); touch();
}

function rowIsSquare(block) {
  const pids = block.slots.filter(Boolean);
  return pids.length > 0 && pids.every((pid) => state.photos[pid].cropRatio === 1);
}

async function toggleRowSquares(block, btn) {
  const pids = block.slots.filter(Boolean);
  if (!pids.length) { layoutNote('Put some photos in that row first.'); return; }
  const undo = rowIsSquare(block);
  if (btn) btn.disabled = true;
  for (const pid of pids) {
    if (undo) await restorePhoto(pid);
    else await centreSquare(pid);
  }
  if (btn) btn.disabled = false;
  layoutNote(undo
    ? `Put ${pids.length} photo${pids.length === 1 ? '' : 's'} back to their original shape.`
    : `Squared off ${pids.length} photo${pids.length === 1 ? '' : 's'} in that row. Click a photo to fine-tune its crop.`);
  renderBlocks(); renderTray(); touch();
}

/* ----------------------------------------------------------------- photos */
function loadFiles(files) {
  [...files].forEach((f) => {
    if (!/^image\//.test(f.type)) return;
    const img = new Image();
    img.onload = () => {
      const make = (edge, q) => {
        const sc = Math.min(1, edge / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * sc);
        c.height = Math.round(img.height * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return { url: c.toDataURL('image/jpeg', q), w: c.width, h: c.height };
      };
      const full = make(MAX_EDGE, JPEG_Q);
      const thumb = make(THUMB_EDGE, 0.75);
      const pid = crypto.randomUUID();
      state.photos[pid] = {
        id: pid,
        filename: slugify(f.name.replace(/\.[^.]+$/, '')) || 'photo',
        alt: '', caption: '', w: full.w, h: full.h,
        full: full.url, thumb: thumb.url,
        mediaId: null, mediaUrl: null,
      };
      state.photoOrder.push(pid);
      if (!state.featuredPid) state.featuredPid = pid;
      URL.revokeObjectURL(img.src);
      renderTray(); touch();
    };
    img.src = URL.createObjectURL(f);
  });
}

/* ------------------------------------------------------------- folder culling
   Open a whole folder (Dropbox syncs to a local folder, so no Dropbox login is
   needed) as a contact sheet, pick the keepers, add only those to the post.
   Chrome/Edge use the directory picker; everywhere else falls back to the
   <input webkitdirectory> folder chooser. Nothing is uploaded until the
   picked photos go through the normal loadFiles() path.
   If the JPEGs carry Bridge/Lightroom star ratings in their XMP, the tiles
   show them and one button pre-picks everything rated 3+. */
const cull = { items: [], filter: 'all', focus: 0, added: new Set(), folder: '' };
const CULL_THUMB = 320;

async function pickFolder() {
  if (window.showDirectoryPicker) {
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'read' }); }
    catch (e) { if (e && e.name === 'AbortError') return; $('folderInput').click(); return; }
    const files = await collectImages(dir, '', 0);
    cull.folder = dir.name;
    startCull(files);
  } else {
    $('folderInput').click();
  }
}
async function collectImages(dir, prefix, depth) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.') || name.startsWith('._')) continue;
    if (h.kind === 'file') {
      if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
      out.push({ file: await h.getFile(), path: prefix + name });
    } else if (h.kind === 'directory' && depth < 2) {
      out.push(...await collectImages(h, prefix + name + '/', depth + 1));
    }
  }
  return out;
}
function startCull(entries) {
  // entries: [{file, path}] or a FileList from <input webkitdirectory>
  const list = [...entries].map((e) => e.file ? e : { file: e, path: e.webkitRelativePath || e.name })
    .filter((e) => /\.(jpe?g|png|webp)$/i.test(e.path) && !/(^|\/)\.|(^|\/)\._/.test(e.path));
  list.sort((x, y) => x.path.localeCompare(y.path, undefined, { numeric: true }));
  if (!list.length) { alert('No JPG, PNG or WebP photos in that folder.'); return; }
  if (!cull.folder) cull.folder = (list[0].path.split('/')[0] || 'folder');
  // keep picks if the same folder is reopened
  const prev = new Map(cull.items.map((it) => [it.key, it]));
  cull.items = list.map((e) => {
    const key = e.path + ':' + e.file.size;
    const old = prev.get(key);
    return old || { key, file: e.file, path: e.path, name: e.path.split('/').pop(),
      thumb: '', rating: 0, label: '', picked: false, big: null };
  });
  cull.filter = 'all'; cull.focus = 0;
  document.querySelectorAll('.cullfilters [data-cf]').forEach((b) => b.classList.toggle('on', b.dataset.cf === 'all'));
  $('cullTitle').textContent = `Pick the photos for this post — ${cull.folder}`;
  $('cullModal').classList.remove('hidden');
  renderCull();
  buildCullThumbs();
}
async function buildCullThumbs() {
  const pending = cull.items.filter((it) => !it.thumb);
  let done = 0;
  const say = () => { $('cullHint').textContent = pending.length && done < pending.length
    ? `Reading ${done} of ${pending.length} photos…` : `${cull.items.length} photos. Ratings: ${cull.items.filter((i) => i.rating > 0).length} rated.`; };
  say();
  const worker = async () => {
    while (pending.length) {
      const it = pending.shift();
      try {
        [it.thumb, { rating: it.rating, label: it.label }] = await Promise.all([makeCullThumb(it.file), readXmpRating(it.file)]);
      } catch { it.thumb = 'data:,'; }
      done++;
      const tile = document.querySelector(`.ctile[data-key="${CSS.escape(it.key)}"]`);
      if (tile) paintTile(tile, it);
      if (done % 10 === 0 || !pending.length) { say(); updateCullButtons(); }
    }
  };
  await Promise.all([worker(), worker()]);
  say(); updateCullButtons();
}
/* Decode a photo file and scale it to `edge` on its long side. Deliberately the
   same <img> + canvas path loadFiles() has always used — createImageBitmap on
   hundreds of full-res camera JPEGs blew Chrome's GPU canvas budget and the
   tiles came back as bands of other photos. One at a time, small canvas,
   release the object URL immediately. */
function decodeScaled(file, edge, quality) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = 'async';
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const sc = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * sc));
        c.height = Math.max(1, Math.round(img.naturalHeight * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const out = c.toDataURL('image/jpeg', quality);
        c.width = c.height = 0;           // give the canvas memory back right away
        res(out);
      } catch (e) { rej(e); }
      finally { URL.revokeObjectURL(url); img.src = ''; }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode failed')); };
    img.src = url;
  });
}
function makeCullThumb(file) { return decodeScaled(file, CULL_THUMB, 0.72); }
/* Bridge / Lightroom write xmp:Rating and xmp:Label into the JPEG's XMP packet,
   which sits in the first few hundred KB. Read just that much. */
async function readXmpRating(file) {
  try {
    const head = await file.slice(0, 262144).text();
    const r = head.match(/xmp:Rating="(-?\d)"/) || head.match(/<xmp:Rating>(-?\d)<\/xmp:Rating>/);
    const l = head.match(/xmp:Label="([^"]*)"/) || head.match(/<xmp:Label>([^<]*)<\/xmp:Label>/);
    return { rating: r ? Number(r[1]) : 0, label: l ? l[1] : '' };
  } catch { return { rating: 0, label: '' }; }
}
function cullVisible() {
  return cull.items.filter((it) => cull.filter === 'all' ? true : cull.filter === 'picked' ? it.picked : !it.picked);
}
function paintTile(tile, it) {
  tile.className = 'ctile' + (it.picked ? ' picked' : '') + (cull.added.has(it.key) ? ' inpost' : '');
  tile.innerHTML = (it.thumb ? `<img src="${it.thumb}" alt="" draggable="false">` : '<span class="pend">reading…</span>') +
    (it.rating > 0 ? `<span class="star">${'★'.repeat(it.rating)}</span>` : '') +
    `<span class="nm" title="${esc(it.path)}">${esc(it.name)}</span>`;
}
function renderCull() {
  const grid = $('cullGrid');
  grid.innerHTML = '';
  const vis = cullVisible();
  vis.forEach((it, i) => {
    const tile = document.createElement('div');
    tile.dataset.key = it.key;
    paintTile(tile, it);
    if (i === cull.focus) tile.classList.add('focus');
    tile.onclick = () => { cull.focus = i; togglePick(it); };
    tile.ondblclick = (e) => { e.preventDefault(); cull.focus = i; openCullView(); };
    grid.appendChild(tile);
  });
  if (!vis.length) grid.innerHTML = '<p class="hint" style="grid-column:1/-1;text-align:center;padding:40px 0">Nothing here with this filter.</p>';
  updateCullButtons();
}
function setCullFocus(i, scroll) {
  const vis = cullVisible();
  if (!vis.length) return;
  cull.focus = Math.max(0, Math.min(vis.length - 1, i));
  document.querySelectorAll('.ctile.focus').forEach((t) => t.classList.remove('focus'));
  const tile = $('cullGrid').children[cull.focus];
  if (tile && tile.classList) { tile.classList.add('focus'); if (scroll) tile.scrollIntoView({ block: 'nearest' }); }
}
function togglePick(it, force) {
  it.picked = force === undefined ? !it.picked : !!force;
  const tile = document.querySelector(`.ctile[data-key="${CSS.escape(it.key)}"]`);
  if (tile) { const wasFocus = tile.classList.contains('focus'); paintTile(tile, it); if (wasFocus) tile.classList.add('focus'); }
  if (cull.filter !== 'all') renderCull();   // it may have just left this filter
  updateCullButtons();
}
function updateCullButtons() {
  const picked = cull.items.filter((it) => it.picked && !cull.added.has(it.key)).length;
  const btn = $('cullAddBtn');
  btn.disabled = !picked;
  btn.textContent = `Add ${picked} picked photo${picked === 1 ? '' : 's'}`;
  const rated = cull.items.some((it) => it.rating >= 3);
  $('cullStarBtn').hidden = !rated;
}
function openCullView() {
  const vis = cullVisible(); const it = vis[cull.focus];
  if (!it) return;
  $('cullView').classList.remove('hidden');
  $('cullViewName').textContent = `${it.name}${it.rating ? '  ' + '★'.repeat(it.rating) : ''}`;
  $('cullViewPick').textContent = it.picked ? '✓ Picked' : 'Pick';
  $('cullViewPick').classList.toggle('on', it.picked);
  const img = $('cullViewImg');
  img.src = it.thumb;               // instant, then sharpen
  bigFor(it).then((u) => { if (cullVisible()[cull.focus] === it) img.src = u; });
}
async function bigFor(it) {
  if (it.big) return it.big;
  try { it.big = await decodeScaled(it.file, 1600, 0.85); }
  catch { it.big = it.thumb; }
  return it.big;
}
function closeCullView() { $('cullView').classList.add('hidden'); setCullFocus(cull.focus, true); }
function addPickedToPost() {
  const keep = cull.items.filter((it) => it.picked && !cull.added.has(it.key));
  if (!keep.length) return;
  loadFiles(keep.map((it) => it.file));
  keep.forEach((it) => cull.added.add(it.key));
  $('cullModal').classList.add('hidden');
  $('photoState').textContent = `Added ${keep.length} photo${keep.length === 1 ? '' : 's'} from ${cull.folder}. Open the folder again any time to pick more — picks are remembered.`;
  $('stepPhotos').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cullKeys(e) {
  if ($('cullModal').classList.contains('hidden')) return;
  const viewing = !$('cullView').classList.contains('hidden');
  const vis = cullVisible(); const it = vis[cull.focus];
  const cols = (() => { const g = $('cullGrid'); const t = g.children[0]; return t ? Math.max(1, Math.floor(g.clientWidth / (t.offsetWidth + 8))) : 1; })();
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); if (viewing) closeCullView(); else $('cullModal').classList.add('hidden'); return; }
  if (k === 'ArrowRight') { e.preventDefault(); setCullFocus(cull.focus + 1, true); if (viewing) openCullView(); return; }
  if (k === 'ArrowLeft')  { e.preventDefault(); setCullFocus(cull.focus - 1, true); if (viewing) openCullView(); return; }
  if (k === 'ArrowDown' && !viewing) { e.preventDefault(); setCullFocus(cull.focus + cols, true); return; }
  if (k === 'ArrowUp' && !viewing)   { e.preventDefault(); setCullFocus(cull.focus - cols, true); return; }
  if ((k === ' ' || k === 'p' || k === 'P') && it) { e.preventDefault(); togglePick(it); if (viewing) openCullView(); return; }
  if ((k === 'x' || k === 'X') && it) { e.preventDefault(); togglePick(it, false); if (viewing) openCullView(); return; }
  if ((k === 'Enter' || k === 'f' || k === 'F') && it && !viewing) { e.preventDefault(); openCullView(); return; }
}

function usedPids() {
  const used = new Set();
  state.blocks.forEach((b) => { if (b.type === 'row') b.slots.forEach((p) => p && used.add(p)); });
  return used;
}

function renderTray() {
  const used = usedPids();
  const tray = $('tray');
  tray.innerHTML = '';
  state.photoOrder.forEach((pid) => {
    const p = state.photos[pid];
    if (!p) return;
    const d = document.createElement('div');
    d.className = 'thumb' + (used.has(pid) ? ' used' : '');
    d.innerHTML = `<img src="${p.thumb}" alt="">` +
      (state.featuredPid === pid ? '<span class="star">★</span>' : '') +
      (p.crop ? `<span class="cropped">${p.cropRatio === 1 ? 'square' : 'cropped'}</span>` : '') +
      (used.has(pid) ? '<span class="flag">in post</span>' : '');
    d.onclick = () => openPhotoModal(pid);
    tray.appendChild(d);
  });
}


/* Write alt text (and a filename) for the one photo that's open. */
async function altForOnePhoto() {
  if (!modalPid) return;
  const btn = $('pmAltAi');
  btn.disabled = true;
  $('pmAltState').textContent = 'Looking at this photo…';
  try {
    const r = await api(API + '/alt', {
      method: 'POST',
      body: JSON.stringify({
        title: state.title, location: state.location, keywords: getKeywords(),
        thumbs: [{ dataBase64: state.photos[modalPid].thumb.split(',')[1] }],
      }),
    });
    const p = state.photos[modalPid];
    if (r.altTexts && r.altTexts[0]) { p.alt = r.altTexts[0]; $('pmAlt').value = p.alt; }
    if (r.imageFilenames && r.imageFilenames[0]) {
      p.filename = slugify(r.imageFilenames[0]);
      $('pmFilename').value = p.filename;
    }
    $('pmAltState').textContent = 'Done — edit it if you like.';
    renderTray(); renderSeoCheck(); touch();
  } catch (e) {
    $('pmAltState').textContent = 'Could not write it just now (' + e.message + ').';
  }
  btn.disabled = false;
}

let modalPid = null;
function openPhotoModal(pid) {
  modalPid = pid;
  const p = state.photos[pid];
  $('pmImg').src = p.thumb;
  $('pmAlt').value = p.alt;
  $('pmFilename').value = p.filename;
  $('pmCaption').value = p.caption || '';
  $('pmAltState').textContent = '';
  // A photo that isn't placed in any row gets an obvious way back in.
  $('pmPutBack').classList.toggle('hidden', usedPids().has(pid));
  $('photoModal').classList.remove('hidden');
}

/* ----------------------------------------------------------------- blocks */
function addBlock(kind, at) {
  const sizes = { row1: 1, row2: 2, row3: 3, row4: 4 };
  const b = kind === 'text' ? { type: 'text', text: '' }
    : kind === 'heading' ? { type: 'heading', text: '' }
    : { type: 'row', slots: new Array(sizes[kind] || 1).fill(null) };
  if (at == null) state.blocks.push(b); else state.blocks.splice(at, 0, b);
  renderBlocks(); touch();
}

function renderBlocks() {
  const box = $('blocks');
  box.innerHTML = '';
  if (!state.blocks.length) {
    box.innerHTML = '<p class="hint">Nothing here yet — add a photo row or paste Amy\'s words to begin.</p>';
  }
  state.blocks.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'block';
    const rowTool = b.type === 'row'
      ? `<button title="Mix it — shuffle the photos in this row" data-act="mix">⇄</button>
         <button title="${rowIsSquare(b) ? 'Back to original shapes' : 'Make this row square'}" data-act="sq">${rowIsSquare(b) ? '▢' : '▣'}</button>`
      : '';
    const tools = `<div class="tools">
      ${rowTool}
      <button title="Move up" data-act="up">↑</button>
      <button title="Move down" data-act="down">↓</button>
      <button title="Delete" data-act="del">✕</button></div>`;
    if (b.type === 'text') {
      d.innerHTML = tools + `<textarea rows="3" placeholder="Words…">${esc(b.text)}</textarea>`;
      const ta = d.querySelector('textarea');
      const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.oninput = () => { b.text = ta.value; fit(); touch(); scheduleSeoCheck(); };
      requestAnimationFrame(fit);
    } else if (b.type === 'heading') {
      d.innerHTML = tools + `<input class="headinput" placeholder="Heading…" value="${esc(b.text)}">`;
      d.querySelector('input').oninput = (e) => { b.text = e.target.value; touch(); };
    } else {
      const row = document.createElement('div');
      const filled = b.slots.filter(Boolean);
      const lonelyVertical = filled.length === 1 && isVertical(filled[0]);
      row.className = 'photo-row' + (lonelyVertical ? ' lonely' : '');
      b.slots.forEach((pid, si) => {
        const slot = document.createElement('div');
        slot.className = 'slot';
        const p = pid && state.photos[pid];
        if (p) {
          slot.style.flex = `${(p.w / p.h).toFixed(3)} 1 0%`;
          slot.style.aspectRatio = `${p.w} / ${p.h}`;
          slot.innerHTML = `<img src="${p.thumb}" alt="">
            <div class="slot-hover">
              <button data-s="crop" title="Crop this photo">⬚ Crop</button>
              <button data-s="info" title="Alt text, file name, caption">ⓘ Details</button>
              <button data-s="swap" title="Put a different photo here">⇆ Swap</button>
              <button data-s="clear" title="Take this photo out of the row">✕ Remove</button>
            </div>`;
          slot.querySelector('[data-s=crop]').onclick = (e) => { e.stopPropagation(); openCrop(pid); };
          slot.querySelector('[data-s=info]').onclick = (e) => { e.stopPropagation(); openPhotoModal(pid); };
          slot.querySelector('[data-s=swap]').onclick = (e) => { e.stopPropagation(); openPicker(b, si); };
          slot.querySelector('[data-s=clear]').onclick = (e) => {
            e.stopPropagation();
            removeFromRow(b, si);
          };
        } else {
          slot.textContent = '+ photo';
          slot.onclick = () => openPicker(b, si);
        }
        row.appendChild(slot);
      });
      d.innerHTML = tools;
      d.appendChild(row);
      if (lonelyVertical) {
        const warn = document.createElement('p');
        warn.className = 'hint lonely-note';
        warn.textContent = 'Verticals are never shown alone — add another photo to this row.';
        d.appendChild(warn);
      }
    }
    d.querySelectorAll('.tools button').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'mix') { mixRow(b); return; }
        if (act === 'sq') { toggleRowSquares(b, btn); return; }
        if (act === 'del') state.blocks.splice(i, 1);
        if (act === 'up' && i > 0) [state.blocks[i - 1], state.blocks[i]] = [state.blocks[i], state.blocks[i - 1]];
        if (act === 'down' && i < state.blocks.length - 1) [state.blocks[i + 1], state.blocks[i]] = [state.blocks[i], state.blocks[i + 1]];
        renderBlocks(); renderTray(); touch();
      };
    });
    wireDrag(d, i);
    box.appendChild(d);
  });
  renderOutline();
}


/* Brief explanatory line under the layout buttons. */
let noteTimer = null;
function layoutNote(msg) {
  const el = $('layoutNote');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}


/* Repair any row that ended up with a single vertical: merge it into a
   neighbouring row that has room, or pair it with an unused photo. */
function fixLoneVerticals() {
  let fixed = 0;
  const used = usedPids();
  const spare = state.photoOrder.filter((pid) => !used.has(pid));
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b.type !== 'row') continue;
    const filled = b.slots.filter(Boolean);
    if (filled.length !== 1 || !isVertical(filled[0]) || mustStandAlone(filled[0])) continue;

    // 1. a spare photo, preferring another vertical, joins it
    const spareIdx = spare.findIndex(isVertical);
    const pick = spareIdx >= 0 ? spare.splice(spareIdx, 1)[0] : spare.shift();
    if (pick) { b.slots = [filled[0], pick]; fixed++; continue; }

    // 2. otherwise fold it into an adjacent row that isn't full
    const neighbours = [state.blocks[i - 1], state.blocks[i + 1]]
      .filter((n) => n && n.type === 'row' && n.slots.filter(Boolean).length < 3);
    if (neighbours.length) {
      neighbours[0].slots = neighbours[0].slots.filter(Boolean).concat(filled[0]);
      state.blocks.splice(i, 1);
      fixed++;
    }
  }
  if (fixed) { renderBlocks(); renderTray(); touch(); }
  return fixed;
}


/* ------------------------------------------------------- drag to reorder
   Blocks are draggable, and a small outline of the whole post floats beside
   them so it stays obvious where you are and what else is in the post. */
let dragFrom = null;

function moveBlock(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.blocks.length) return;
  const [b] = state.blocks.splice(from, 1);
  state.blocks.splice(to > from ? to - 1 : to, 0, b);
  renderBlocks(); touch();
}

function clearDragMarks() {
  document.querySelectorAll('.block, .omini').forEach((b) =>
    b.classList.remove('dragging', 'over-top', 'over-bottom'));
}

/* Used by both the full blocks and the little outline, so a block can be picked
   up in either one and dropped in the other. */
function wireDrag(el, index) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragFrom = index;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(index)); } catch { /* Safari */ }
  });
  el.addEventListener('dragend', () => {
    dragFrom = null;
    clearDragMarks();
  });
  el.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    el.classList.toggle('over-bottom', after);
    el.classList.toggle('over-top', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('over-top', 'over-bottom'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over-top', 'over-bottom');
    if (dragFrom === null) return;
    const r = el.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    moveBlock(dragFrom, index + (after ? 1 : 0));
    dragFrom = null;
  });
}

/* The little map of the post. */
function renderOutline() {
  const box = $('outlineList');
  if (!box) return;
  box.innerHTML = '';
  if (!state.blocks.length) {
    box.innerHTML = '<p class="hint">Nothing yet.</p>';
    $('outlineCount').textContent = '';
    return;
  }
  state.blocks.forEach((b, i) => {
    const item = document.createElement('div');
    item.className = 'omini';
    if (b.type === 'row') {
      const filled = b.slots.filter(Boolean);
      const strip = document.createElement('div');
      strip.className = 'ostrip';
      filled.forEach((pid) => {
        const im = document.createElement('img');
        im.src = state.photos[pid] ? state.photos[pid].thumb : '';
        im.className = isVertical(pid) ? 'v' : 'h';
        strip.appendChild(im);
      });
      if (!filled.length) strip.innerHTML = '<span class="hint">empty row</span>';
      item.appendChild(strip);
      const tag = document.createElement('span');
      tag.className = 'otag';
      tag.textContent = ['—', 'single', 'diptych', 'triptych', 'four'][filled.length] || `${filled.length} across`;
      if (filled.length && rowIsSquare(b)) tag.textContent += ' ▣';
      item.appendChild(tag);
    } else {
      item.classList.add('otext');
      item.textContent = (b.type === 'heading' ? '\u275D ' : '') + (b.text || '(empty)').slice(0, 46);
    }
    item.onclick = () => {
      const target = document.querySelectorAll('#blocks .block')[i];
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1200);
      }
    };
    wireDrag(item, i);
    box.appendChild(item);
  });
  const rows = state.blocks.filter((b) => b.type === 'row').length;
  const photos = state.blocks.reduce((n, b) => n + (b.type === 'row' ? b.slots.filter(Boolean).length : 0), 0);
  $('outlineCount').textContent = `${photos} photos \u00b7 ${rows} rows`;
}


/* Taking a photo out of a row. If it leaves exactly one photo behind, ask what
   should happen to it rather than silently leaving a gap. */
let rowChoice = null;   // { block, slotIndex, removedPid, remainingPid }

function removeFromRow(block, slotIndex) {
  const removedPid = block.slots[slotIndex];
  const before = block.slots.filter(Boolean).length;
  block.slots[slotIndex] = null;
  const left = block.slots.filter(Boolean);

  // Any removal that leaves a hole gets a question — a three going to two
  // should become a proper diptych, not a row with a gap in it.
  if (before > 1 && left.length >= 1 && left.length < block.slots.length) {
    rowChoice = { block, slotIndex, removedPid, remaining: left };
    showRowChoice();
    return;
  }
  renderBlocks(); renderTray(); touch();
}

function showRowChoice() {
  const { remaining } = rowChoice;
  const n = remaining.length;
  const NAMES = ['', 'on its own', 'a diptych', 'a triptych', 'a row of four'];

  $('rcTitle').textContent = n === 1
    ? 'One photo left in that row'
    : `${n === 2 ? 'Two' : n === 3 ? 'Three' : n} photos left in that row`;

  // Show what is actually left, not just the first one.
  const grid = $('rcPhotos');
  grid.innerHTML = '';
  remaining.forEach((pid) => {
    const im = document.createElement('img');
    im.src = state.photos[pid].thumb;
    grid.appendChild(im);
  });

  // The vertical rule only bites when a single photo would be left behind.
  const lonelyVertical = n === 1 && isVertical(remaining[0]) && !mustStandAlone(remaining[0]);
  $('rcAlone').disabled = lonelyVertical;
  $('rcAlone').textContent = lonelyVertical
    ? 'Can\u2019t stand alone (vertical)'
    : n === 1 ? 'Let it stand alone' : `Make it ${NAMES[n] || 'that size'}`;
  $('rcNote').textContent = lonelyVertical
    ? 'Vertical photos are never shown alone, so this one needs a partner.'
    : n === 1
      ? 'It will fill the width on its own.'
      : `The row closes up into ${NAMES[n] || 'that size'} — no gap left behind.`;
  $('rcSwap').textContent = 'Swap in another photo';
  $('rowChoiceModal').classList.remove('hidden');
}

function resolveRowChoice(what) {
  if (!rowChoice) return;
  const { block, slotIndex, removedPid, remaining } = rowChoice;
  $('rowChoiceModal').classList.add('hidden');
  if (what === 'alone') {
    block.slots = remaining.slice();          // close the gap up
    renderBlocks(); renderTray(); touch();
  } else if (what === 'swap') {
    block.slots = remaining.concat([null]);   // keep one empty spot, at the end
    renderBlocks(); renderTray(); touch();
    openPicker(block, remaining.length);
  } else {                                    // undo
    block.slots[slotIndex] = removedPid;
    renderBlocks(); renderTray(); touch();
  }
  rowChoice = null;
}

let pickTarget = null;
function openPicker(block, slotIndex) {
  pickTarget = { block, slotIndex };
  const used = usedPids();
  const grid = $('pickerGrid');
  grid.innerHTML = '';
  const order = [...state.photoOrder].sort((a, b2) => (used.has(a) ? 1 : 0) - (used.has(b2) ? 1 : 0));
  order.forEach((pid) => {
    const p = state.photos[pid];
    const d = document.createElement('div');
    const soloRow = pickTarget.block.slots.length === 1;
    const vertical = isVertical(pid);
    d.className = 'thumb' + (used.has(pid) ? ' used' : '') + (soloRow && vertical ? ' needspair' : '');
    d.innerHTML = `<img src="${p.thumb}" alt="">`
      + (used.has(pid) ? '<span class="flag">in post</span>'
        : (soloRow && vertical ? '<span class="flag">becomes a pair</span>' : ''));
    d.onclick = () => {
      pickTarget.block.slots[pickTarget.slotIndex] = pid;
      // A vertical is never left standing alone — grow the row into a diptych.
      if (soloRow && vertical) {
        pickTarget.block.slots.push(null);
        layoutNote('Verticals are never shown alone, so that row is now a diptych — drop a second photo in.');
      }
      $('picker').classList.add('hidden');
      renderBlocks(); renderTray(); touch();
    };
    grid.appendChild(d);
  });
  if (!order.length) grid.innerHTML = '<p class="hint">Add photos in step 2 first.</p>';
  $('picker').classList.remove('hidden');
}

/* words + magic layout */
function addWords(raw) {
  const paras = raw.split(/\n\s*\n/).map((s) => s.trim().replace(/\s*\n\s*/g, ' ')).filter(Boolean);
  if (!paras.length) return;
  const rowIdxs = state.blocks.map((b, i) => (b.type === 'row' ? i : -1)).filter((i) => i >= 0);
  if (!rowIdxs.length) {
    paras.forEach((t) => state.blocks.push({ type: 'text', text: t }));
  } else {
    // first paragraph before the first row, then spread the rest after rows
    const inserts = [];
    inserts.push({ at: rowIdxs[0], t: paras[0] });
    const rest = paras.slice(1);
    const step = Math.max(1, Math.floor(rowIdxs.length / (rest.length || 1)));
    rest.forEach((t, i) => {
      const rowN = Math.min(rowIdxs.length - 1, (i + 1) * step - 1);
      inserts.push({ at: rowIdxs[rowN] + 1, t });
    });
    inserts.sort((a, b) => b.at - a.at)
      .forEach((ins) => state.blocks.splice(ins.at, 0, { type: 'text', text: ins.t }));
  }
  renderBlocks(); touch();
}



/* ---------------------------------------------------------------- layout
   The AI photo analysis that ranked family-session moments is deliberately
   not part of this app — a school blog wants the photos in the order they
   were dropped in. What survives are the two shape rules that hold for any
   photo blog:
     1. A vertical is never shown alone — it pairs or goes in a three.
     2. Everything else leans towards single horizontals for rhythm.
   analysisOf() stays because the row helpers call it; with nothing writing
   `.analysis` it simply returns {} and those checks fall through. */
function analysisOf(pid) { return (state.photos[pid] || {}).analysis || {}; }
function mustStandAlone(pid) { return !!analysisOf(pid).fullGroup; }

/* Rule: a vertical photo is never shown on its own — verticals always sit
   in a diptych or triptych. Horizontals may stand alone. */
function isVertical(pid) {
  const p = state.photos[pid];
  return !!p && p.h > p.w;
}
function loneVerticalRows() {
  return state.blocks.filter((b) => {
    if (b.type !== 'row') return false;
    const filled = b.slots.filter(Boolean);
    // A whole-group shot always stands alone — that rule wins over this one.
    return filled.length === 1 && isVertical(filled[0]) && !mustStandAlone(filled[0]);
  });
}

function magicLayout() {
  const used = usedPids();
  const free = state.photoOrder.filter((pid) => !used.has(pid));
  if (!free.length) return;
  // Sizes to reach for, in order, purely for visual rhythm.
  const pattern = [1, 2, 3, 2, 1, 3, 2, 2];
  const rows = [];
  let pi = 0;
  while (free.length) {
    const wantsVertical = isVertical(free[0]);
    let n = Math.min(pattern[pi % pattern.length], free.length);
    if (wantsVertical) {
      // Must be grouped. Prefer running with the verticals that follow it.
      let run = 0;
      while (run < free.length && run < 3 && isVertical(free[run])) run++;
      n = run >= 3 ? 3 : Math.min(Math.max(2, Math.min(n, 3)), free.length);
    } else if (n === 1 && free.length > 1 && isVertical(free[1])) {
      // Leaving a horizontal alone here would strand the vertical behind it
      // only if nothing follows; harmless otherwise, so keep the single.
      n = 1;
    }
    // Never strand a single vertical at the very end. Prefer shrinking this row
    // so two are left for a final pair; only grow if shrinking isn't allowed.
    if (free.length - n === 1 && isVertical(free[free.length - 1])) {
      const minRow = wantsVertical ? 2 : 1;
      if (n - 1 >= minRow) n -= 1;
      else if (n + 1 <= 3) n += 1;
    }
    n = Math.min(n, 3, free.length);   // rows never hold more than three
    rows.push({ type: 'row', slots: free.splice(0, n) });
    pi += 1;
  }
  // Safety net: fold any lone vertical row into a neighbour.
  for (let i = rows.length - 1; i >= 0; i--) {
    const slots = rows[i].slots;
    if (slots.length !== 1 || !isVertical(slots[0])) continue;
    const prev = rows[i - 1];
    const next = rows[i + 1];
    if (prev && prev.slots.filter(Boolean).length < 3) { prev.slots.push(slots[0]); rows.splice(i, 1); }
    else if (next && next.slots.filter(Boolean).length < 3) { next.slots.unshift(slots[0]); rows.splice(i, 1); }
  }
  rows.forEach((r) => state.blocks.push(r));
  renderBlocks(); renderTray(); touch();
}

/* -------------------------------------------------- source material → intro
   A flyer, program, press release or email — PDF or photos of it — that the AI
   reads to draft the opening paragraph (what / when / where / who / why). The
   documents are source material only: kept in memory, never saved with the
   draft, never published. Only the extracted facts are kept (state.sourceFacts)
   so the ✨ suggestions agree with the flyer. */
let sourceDocs = [];   // [{ id, name, mediaType, dataBase64, thumb }]
const SRC_MAX_PDF = 15 * 1024 * 1024;   // per file
const SRC_MAX_TOTAL = 20 * 1024 * 1024; // what the backend will accept

function srcTotalBytes() {
  return sourceDocs.reduce((n, d) => n + d.dataBase64.length * 0.75, 0);
}
function renderSourceDocs() {
  const box = $('srcList');
  if (!box) return;
  box.innerHTML = '';
  sourceDocs.forEach((d, i) => {
    const el = document.createElement('span');
    el.className = 'srcitem';
    el.innerHTML = (d.mediaType === 'application/pdf'
      ? '<span class="pdf">PDF</span>'
      : `<img src="${d.thumb}" alt="">`) +
      `<span>${esc(d.name)}</span><button title="Remove">✕</button>`;
    el.querySelector('button').onclick = () => { sourceDocs.splice(i, 1); renderSourceDocs(); };
    box.appendChild(el);
  });
  $('introBtn').disabled = !sourceDocs.length;
  const mb = (srcTotalBytes() / 1048576).toFixed(1);
  $('srcState').textContent = sourceDocs.length
    ? `${sourceDocs.length} document${sourceDocs.length === 1 ? '' : 's'} ready (${mb} MB).`
    : '';
}
function addSourceFiles(files) {
  [...files].forEach((f) => {
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    const isImg = /^image\/(jpeg|png|webp)$/.test(f.type);
    if (!isPdf && !isImg) { $('srcState').textContent = `Skipped ${f.name} — only PDF, JPG, PNG or WebP.`; return; }
    if (isPdf) {
      if (f.size > SRC_MAX_PDF) { $('srcState').textContent = `${f.name} is ${(f.size / 1048576).toFixed(0)} MB — keep PDFs under 15 MB.`; return; }
      const rd = new FileReader();
      rd.onload = () => {
        sourceDocs.push({ id: crypto.randomUUID(), name: f.name, mediaType: 'application/pdf',
          dataBase64: String(rd.result).split(',')[1], thumb: '' });
        renderSourceDocs();
      };
      rd.readAsDataURL(f);
      return;
    }
    // Images: shrink like the post photos so a phone snap of a flyer doesn't
    // weigh 8 MB — 1600px is plenty for the model to read the text.
    const img = new Image();
    img.onload = () => {
      const make = (edge, q) => {
        const sc = Math.min(1, edge / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * sc));
        c.height = Math.max(1, Math.round(img.height * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', q);
      };
      sourceDocs.push({ id: crypto.randomUUID(), name: f.name, mediaType: 'image/jpeg',
        dataBase64: make(1600, 0.85).split(',')[1], thumb: make(120, 0.7) });
      URL.revokeObjectURL(img.src);
      renderSourceDocs();
    };
    img.src = URL.createObjectURL(f);
  });
}
let lastIntro = null;
async function draftIntro() {
  if (!sourceDocs.length) return;
  if (srcTotalBytes() > SRC_MAX_TOTAL) { alert('Those documents add up to more than 20 MB — remove one or two and try again.'); return; }
  const btn = $('introBtn');
  btn.disabled = true;
  $('srcState').textContent = 'Reading the documents… (about 20–40 seconds)';
  try {
    const r = await api(API + '/intro', {
      method: 'POST',
      body: JSON.stringify({
        docs: sourceDocs.map((d) => ({ name: d.name, mediaType: d.mediaType, dataBase64: d.dataBase64 })),
        title: state.title, location: state.location, text: postText(),
        keywords: getKeywords(),
      }),
    });
    lastIntro = r;
    state.sourceFacts = r.facts && Object.keys(r.facts).length ? r.facts : null;
    $('introText').value = r.intro || '';
    const f = r.facts || {};
    const order = ['what', 'when', 'where', 'who', 'why', 'how'];
    $('introFacts').innerHTML = order.filter((k) => f[k]).map((k) =>
      `<span class="k">${k}</span><span>${esc(f[k])}</span>`).join('');
    $('introUnsure').textContent = (r.unsure && r.unsure.length)
      ? 'Couldn\'t read or wasn\'t sure about: ' + r.unsure.join('; ') : '';
    $('introModal').classList.remove('hidden');
    $('srcState').textContent = 'Drafted. Add it from the window, or close and try again with better photos of the flyer.';
    touch();
  } catch (e) {
    $('srcState').textContent = 'Couldn\'t draft it (' + e.message + '). Try a clearer photo or a PDF.';
  }
  btn.disabled = false;
}
function useIntro() {
  const textIn = $('introText').value.trim();
  if (!textIn) return;
  // The opening goes first. If the post already opens with words, the new
  // paragraph sits above them rather than overwriting anything.
  state.blocks.unshift({ type: 'text', text: textIn });
  // Fill in blanks the flyer answered, without overwriting anything typed.
  if (lastIntro) {
    if (!state.title.trim() && lastIntro.suggestedTitle) {
      state.title = lastIntro.suggestedTitle; $('fTitle').value = state.title; slugTouched = false; syncSlug();
    }
    if (!state.location.trim() && lastIntro.suggestedLocation) {
      state.location = lastIntro.suggestedLocation; $('fLocation').value = state.location;
    }
  }
  $('introModal').classList.add('hidden');
  renderBlocks(); renderSeoCheck(); touch();
  $('stepLayout').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ------------------------------------------------------------------- SEO */
function syncSlug() {
  if (!slugTouched || !state.slug) {
    state.slug = slugify(state.title.replace(/\|/g, ' '));
    $('fSlug').value = state.slug;
  }
}
/* ------------------------------------------------- links inside the text */
function postText() {
  return state.blocks.filter((b) => b.type === 'text' || b.type === 'heading')
    .map((b) => b.text).join('\n\n');
}
/* A suggestion is only usable if its phrase really appears in the words. */
function phraseFound(phrase) {
  return !!phrase && postText().toLowerCase().includes(String(phrase).toLowerCase());
}
function addInlineLink(l) {
  if (!l.phrase || !l.url) return false;
  if (state.inlineLinks.some((x) => x.phrase.toLowerCase() === l.phrase.toLowerCase())) return false;
  state.inlineLinks.push({
    phrase: l.phrase, url: l.url,
    kind: l.kind === 'internal' || l.url.includes(SITE_HOST) ? 'internal' : 'external',
  });
  renderInlineChosen(); touch();
  return true;
}
function renderInlineSuggestions(list) {
  const box = $('inlineSuggestions');
  if (!box) return;
  box.innerHTML = '';
  const usable = list.filter((l) => phraseFound(l.phrase));
  const dropped = list.length - usable.length;
  if (!usable.length) {
    box.innerHTML = '<p class="hint">No in-text link suggestions yet — add your words in step 3, then press the ✨ button.</p>';
    return;
  }
  usable.forEach((l) => {
    const d = document.createElement('div');
    d.className = 'linkitem';
    const host = (() => { try { return new URL(l.url).hostname.replace(/^www\./, ''); } catch { return l.url; } })();
    d.innerHTML = `<span class="t">“<strong>${esc(l.phrase)}</strong>” → ${esc(host)}
      <span class="why">${esc(l.why || '')}</span></span>
      <button title="Use this link">＋</button>`;
    d.querySelector('button').onclick = () => { if (addInlineLink(l)) d.remove(); };
    box.appendChild(d);
  });
  if (dropped) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = `${dropped} suggestion(s) skipped — those exact words aren't in the post text.`;
    box.appendChild(p);
  }
}
function renderInlineChosen() {
  const box = $('inlineChosen');
  if (!box) return;
  box.innerHTML = '';
  if (!state.inlineLinks.length) {
    box.innerHTML = '<p class="hint">None yet. These get linked right inside your sentences.</p>';
    return;
  }
  state.inlineLinks.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'linkitem';
    const ok = phraseFound(l.phrase);
    const host = (() => { try { return new URL(l.url).hostname.replace(/^www\./, ''); } catch { return l.url; } })();
    d.innerHTML = `<span class="t">“<strong>${esc(l.phrase)}</strong>” → ${esc(host)}
      ${ok ? '' : '<span class="why" style="color:#c0392b">those words are no longer in the text — it won\'t be linked</span>'}</span>
      <button title="Remove">✕</button>`;
    d.querySelector('button').onclick = () => { state.inlineLinks.splice(i, 1); renderInlineChosen(); touch(); };
    box.appendChild(d);
  });
}

function renderChosenLinks() {
  const box = $('chosenLinks');
  box.innerHTML = '';
  const mk = (arr, kind) => arr.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'linkitem';
    d.innerHTML = `<span class="t">${esc(l.title)}${l.why ? `<span class="why">${esc(l.why)}</span>` : ''}</span>
      <button title="Remove">✕</button>`;
    d.querySelector('button').onclick = () => { arr.splice(i, 1); renderChosenLinks(); touch(); };
    box.appendChild(d);
  });
  mk(state.links.internal, 'int');
  mk(state.links.external, 'ext');
  if (!state.links.internal.length && !state.links.external.length) {
    box.innerHTML = '<p class="hint">No links chosen yet — search on the left, or let the AI suggest some.</p>';
  }
}
/* christianunified.org is mostly staff/parent forms — permission slips, RSVPs,
   absence reports. Never worth linking from a story, so with an empty search
   box show the public-facing pages first. */
const FORMY = /sign-?in|permission|absence|rsvp|survey|payment|requisition|registration|observation|agreement|concern|interview|handbook|request|directory|fees|budget|assessment|reimburse|payroll|substitute|thank you|received|sign-?up|\bform\b/i;
/* Word boundaries matter: without \b, "Parental Permission" matches "mission"
   and a permission slip outranks the Missions program page. */
const READERLY = /\btours?\b|\badmissions?\b|\bapply\b|\benroll(ment)?\b|\babout\b|\bcampus\b|\bathletics?\b|\barts?\b|\bmusic\b|\bdrama\b|\btheat(er|re)\b|\bchapel\b|\bmissions?\b|\bleadership\b|\bacademics?\b|\bstudent life\b|\bvisit\b|\bcalendar\b|\bspirit\b|\bfaculty\b/i;
function linkRank(title) {
  const t = decode(title || '');
  if (FORMY.test(t)) return 2;    // a form is never worth linking from a story
  if (READERLY.test(t)) return 0;
  return 1;
}
function renderLinkResults() {
  const q = $('linkSearch').value.trim().toLowerCase();
  const box = $('linkResults');
  box.innerHTML = '';
  const all = [...siteData.pages, ...siteData.posts];
  const hits = (q
    ? all.filter((p) => decode(p.title || '').toLowerCase().includes(q))
    : [...all].sort((a, b) => linkRank(a.title) - linkRank(b.title))
  ).slice(0, 12);
  hits.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'linkitem';
    d.innerHTML = `<span class="t">${esc(decode(p.title))}</span><button title="Add">＋</button>`;
    d.querySelector('button').onclick = () => {
      if (!state.links.internal.some((l) => l.url === p.url)) {
        state.links.internal.push({ title: decode(p.title), url: p.url });
        renderChosenLinks(); touch();
      }
    };
    box.appendChild(d);
  });
  if (!hits.length) box.innerHTML = '<p class="hint">Nothing found.</p>';
}

async function aiSuggest() {
  const btn = $('aiBtn');
  btn.disabled = true;
  $('aiState').textContent = 'Looking at the photos and words… (about 20 seconds)';
  try {
    const text = state.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    // A few thumbnails give the model a feel for the event; alt text for every
    // photo is written separately in batches (see writeAllAlts).
    const used = usedPids();
    const sample = state.photoOrder.filter((p) => used.size === 0 || used.has(p)).slice(0, 6);
    const thumbs = sample.map((pid) => ({
      filename: state.photos[pid].filename,
      dataBase64: state.photos[pid].thumb.split(',')[1],
    }));
    const s = await api(API + '/suggest', {
      method: 'POST',
      body: JSON.stringify({
        title: state.title, location: state.location, text, thumbs,
        keywords: getKeywords(),
        facts: state.sourceFacts || undefined,
      }),
    });
    // titles
    const tBox = $('titleOptions');
    tBox.innerHTML = '';
    (s.titleOptions || []).forEach((t) => {
      const b = document.createElement('button');
      b.className = 'chip suggestion';
      b.textContent = t;
      b.onclick = () => {
        state.title = t; $('fTitle').value = t; slugTouched = false; syncSlug(); touch();
      };
      tBox.appendChild(b);
    });
    tBox.classList.toggle('hidden', !tBox.children.length);
    if (!state.title && s.titleOptions?.[0]) {
      state.title = s.titleOptions[0]; $('fTitle').value = state.title;
    }
    if (s.slug && !slugTouched) { state.slug = s.slug; $('fSlug').value = s.slug; }
    if (s.metaDescription) { state.metaDesc = s.metaDescription; $('fMetaDesc').value = s.metaDescription; metaCount(); }
    if (s.focusKeyword) { state.focusKeyword = s.focusKeyword; $('fKeyword').value = s.focusKeyword; }
    if (Array.isArray(s.secondaryKeywords)) state.secondaryKeywords = s.secondaryKeywords;
    if (s.excerpt) state.excerpt = s.excerpt;
    renderInlineSuggestions(s.inlineLinks || []);
    (s.internalLinks || []).slice(0, 4).forEach((l) => {
      if (l.url && !state.links.internal.some((x) => x.url === l.url)) {
        state.links.internal.push({ title: l.title, url: l.url, why: l.why });
      }
    });
    (s.externalLinks || []).slice(0, 3).forEach((l) => {
      if (l.url && !state.links.external.some((x) => x.url === l.url)) {
        state.links.external.push({ title: l.title, url: l.url, why: l.why });
      }
    });
    (s.categoryHints || []).forEach((name) => {
      const c = siteData.categories.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
      if (c && !state.categories.includes(c.id)) state.categories.push(c.id);
    });
    renderCats(); renderChosenLinks(); renderTray(); renderSeoCheck();
    touch();
    const n = await writeAllAlts(false);
    $('aiState').textContent = `Done! Titles, description and links are filled in, and alt text written for ${n} photo${n === 1 ? '' : 's'}.`;
    touch();
  } catch (e) {
    $('aiState').textContent = 'Hmm, the AI helper couldn\'t run (' + e.message + '). Everything still works manually.';
  }
  btn.disabled = false;
}


/* Write alt text + filenames for EVERY photo, in small batches so a post with
   30+ photos works. Returns how many were written. */
async function writeAllAlts(onlyMissing) {
  const used = usedPids();
  let pids = state.photoOrder.filter((p) => used.size === 0 || used.has(p));
  if (onlyMissing) pids = pids.filter((p) => !(state.photos[p].alt || '').trim());
  if (!pids.length) return 0;

  const BATCH = 8;
  let written = 0;
  const say = (m) => { const el = $('aiState'); if (el) el.textContent = m; };
  for (let i = 0; i < pids.length; i += BATCH) {
    const chunk = pids.slice(i, i + BATCH);
    say(`Writing alt text… photo ${i + 1}-${Math.min(i + BATCH, pids.length)} of ${pids.length}`);
    const thumbs = chunk.map((pid) => ({ dataBase64: state.photos[pid].thumb.split(',')[1] }));
    let r;
    try {
      r = await api(API + '/alt', {
        method: 'POST',
        body: JSON.stringify({
          title: state.title, location: state.location,
          keywords: getKeywords(), thumbs, startIndex: i,
        }),
      });
    } catch (e) {
      say(`Alt text stopped at photo ${i + 1} (${e.message}). Press the button again to finish the rest.`);
      break;
    }
    chunk.forEach((pid, j) => {
      const p = state.photos[pid];
      if (!p) return;
      if (r.altTexts && r.altTexts[j]) { p.alt = r.altTexts[j]; written++; }
      if (r.imageFilenames && r.imageFilenames[j]) p.filename = slugify(r.imageFilenames[j]);
    });
    renderTray(); touch();
  }
  renderSeoCheck();
  return written;
}

function metaCount() { $('metaCount').textContent = $('fMetaDesc').value.length; }

/* ------------------------------------------------- keywords & SEO check */
let seoTimer = null;
function scheduleSeoCheck() {
  clearTimeout(seoTimer);
  seoTimer = setTimeout(() => { renderSeoCheck(); renderInlineChosen(); }, 400);
}
function renderKeywordEditor() {
  const box = $('kwChips');
  if (!box) return;
  const list = getKeywords();
  box.innerHTML = '';
  list.forEach((k, i) => {
    const b = document.createElement('span');
    b.className = 'chip kw';
    b.innerHTML = `${esc(k)} <button title="Remove">✕</button>`;
    b.querySelector('button').onclick = () => {
      const l = getKeywords(); l.splice(i, 1); setKeywords(l); renderKeywordEditor();
    };
    box.appendChild(b);
  });
}
function addKeyword() {
  const v = $('kwInput').value.trim();
  if (!v) return;
  const l = getKeywords();
  if (!l.some((k) => k.toLowerCase() === v.toLowerCase())) l.push(v);
  setKeywords(l);
  $('kwInput').value = '';
  renderKeywordEditor();
}

/* Live scorecard: where the focus keyword actually lands. */
function renderSeoCheck() {
  const box = $('seoCheck');
  if (!box) return;
  const kw = (state.focusKeyword || '').trim().toLowerCase();
  if (!kw) {
    box.innerHTML = '<p class="hint">Set a focus keyword above (or press ✨) to see how well this post targets it.</p>';
    return;
  }
  const has = (s) => String(s || '').toLowerCase().includes(kw);
  const body = postText();
  const firstPara = (state.blocks.find((b) => b.type === 'text' && b.text.trim()) || {}).text || '';
  const used = usedPids();
  const alts = [...used].map((p) => state.photos[p]?.alt || '');
  const altHits = alts.filter(has).length;
  const bodyHits = kw ? (body.toLowerCase().split(kw).length - 1) : 0;
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const rows = [
    ['Post title', has(state.title), 'Put the keyword in the title — this matters most.'],
    ['Web address (slug)', has(state.slug.replace(/-/g, ' ')), 'Include it in the slug.'],
    ['Meta description', has(state.metaDesc), 'Work it into the description Google shows.'],
    ['First paragraph', has(firstPara), 'Mention it early, in the first paragraph.'],
    ['Photo alt text', altHits > 0, `Use it in at least one photo's alt text (${altHits} of ${alts.length} now).`],
    ['Used in the words', bodyHits >= 1, `Appears ${bodyHits}× in the body.`],
    ['Enough words to rank', words >= 250, `${words} words — aim for 250+ so Google has something to read.`],
    ['Links inside the text', state.inlineLinks.length >= 2, `${state.inlineLinks.length} in-text link(s).`],
  ];
  const pass = rows.filter((r) => r[1]).length;
  box.innerHTML =
    `<p class="score"><strong>${pass} of ${rows.length}</strong> SEO checks passing for “${esc(state.focusKeyword)}”</p>` +
    rows.map(([label, ok, tip]) =>
      `<div class="check ${ok ? 'ok' : 'no'}"><span>${ok ? '✓' : '○'}</span>
        <span><strong>${esc(label)}</strong>${ok ? '' : ` — <span class="hint">${esc(tip)}</span>`}</span></div>`
    ).join('');
}

/* --------------------------------------------------------- HTML generation */
/* Best "come see us" page on the school site, for the closing line. Tried in
   priority order — a district-wide tour page beats one campus's. */
function tourUrl() {
  const pick = (re) => siteData.pages.find((x) => re.test(decode(x.title || '')));
  const tries = [
    /^(schedule|request|book) a tour/i,
    /^campus tours?$/i,
    /^tours?$/i,
    /^admissions?$/i,
    /\btours?\b/i,          // \b matters: "Golf Tournament" is not a tour
    /^admissions?\b/i,
    /^contact/i,
  ];
  for (const re of tries) { const p = pick(re); if (p) return p.url; }
  return SITE + '/campus-tours/';
}
/* Wrap each chosen phrase in an anchor, once, in the first paragraph that has
   it. Runs on already-escaped HTML, so the needle is escaped the same way and
   we never link inside a tag we just inserted. */
function linkPhrases(escapedHtml, done) {
  let out = escapedHtml;
  state.inlineLinks.forEach((l, idx) => {
    if (done.has(idx)) return;
    const needle = esc(l.phrase);
    // Skip if this chunk already contains an anchor overlapping the phrase.
    const pos = out.toLowerCase().indexOf(needle.toLowerCase());
    if (pos < 0) return;
    const before = out.slice(0, pos);
    if ((before.match(/<a /g) || []).length > (before.match(/<\/a>/g) || []).length) return;
    const actual = out.slice(pos, pos + needle.length); // keep original casing
    const attrs = l.kind === 'external'
      ? ` href="${esc(l.url)}" target="_blank" rel="noopener"`
      : ` href="${esc(l.url)}"`;
    out = before + `<a${attrs}>${actual}</a>` + out.slice(pos + needle.length);
    done.add(idx);
  });
  return out;
}

function buildPostHtml(urlFor) {
  const parts = [];
  const linked = new Set();
  state.blocks.forEach((b) => {
    if (b.type === 'text' && b.text.trim()) {
      parts.push(`<p>${linkPhrases(esc(b.text.trim()), linked)}</p>`);
    } else if (b.type === 'heading' && b.text.trim()) {
      parts.push(`<h2>${esc(b.text.trim())}</h2>`);
    } else if (b.type === 'row') {
      const pids = b.slots.filter((p) => p && state.photos[p]);
      if (!pids.length) return;
      const cells = pids.map((pid) => {
        const p = state.photos[pid];
        const ar = (p.w / p.h).toFixed(4);
        return `<div style="flex:${ar} 1 0%;min-width:0;">` +
          `<img src="${urlFor(p)}" alt="${esc(p.alt)}" width="${p.w}" height="${p.h}" ` +
          `style="width:100%;height:auto;display:block;" loading="lazy" /></div>`;
      }).join('');
      parts.push(`<div style="display:flex;gap:8px;margin:20px 0;">${cells}</div>`);
    }
  });
  const links = [];
  state.links.internal.forEach((l) =>
    links.push(`<li><a href="${esc(l.url)}">${esc(l.title)}</a></li>`));
  state.links.external.forEach((l) =>
    links.push(`<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a></li>`));
  if (links.length) {
    parts.push(
      `<div style="background:#eaf1fa;border-left:5px solid #00244c;padding:26px 30px;border-radius:8px;margin-top:34px;">` +
      `<p style="font-size:1.15em;margin-top:0;"><strong>Keep exploring</strong></p>` +
      `<ul style="margin-bottom:0;">${links.join('')}</ul></div>`);
  }
  parts.push(
    `<p style="margin-top:30px;">Dreaming of photos like these for your own family? ` +
    `<a href="${esc(tourUrl())}">Schedule a campus tour</a>.</p>`);
  parts.push(buildJsonLd(urlFor));
  return parts.join('\n');
}
function buildJsonLd(urlFor) {
  const used = usedPids();
  const images = state.photoOrder.filter((p) => used.has(p))
    .map((pid) => urlFor(state.photos[pid])).filter((u) => u && !u.startsWith('data:'));
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: state.title,
    description: state.metaDesc || state.excerpt || undefined,
    image: images.length ? images : undefined,
    datePublished: new Date().toISOString().slice(0, 10),
    author: { '@type': 'Organization', name: ORG, url: SITE },
    publisher: { '@type': 'Organization', name: ORG, url: SITE },
    mainEntityOfPage: `${SITE}/${state.slug}/`,
    ...(state.location ? { contentLocation: { '@type': 'Place', name: state.location } } : {}),
  };
  return `<script type="application/ld+json">${JSON.stringify(ld)}</scr` + `ipt>`;
}

/* ---------------------------------------------------------------- preview */
function showPreview() {
  const html = buildPostHtml((p) => p.full);
  $('previewFrame').srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400..600&family=Jost:wght@300;400&display=swap" rel="stylesheet">
    <style>
      body{font-family:Jost,sans-serif;font-weight:300;color:#4a4844;max-width:860px;margin:0 auto;padding:30px 20px;line-height:1.7;}
      h1,h2{font-family:Lora,serif;font-weight:500;}
      h1{font-size:2rem;} a{color:#c67a85;}
      img{max-width:100%;}
    </style></head><body>
    <h1>${esc(state.title || 'Untitled post')}</h1>
    ${html}</body></html>`;
  $('previewModal').classList.remove('hidden');
}


/* ------------------------------------------------------ publish date/time
   Times are plain local values interpreted in the website's own timezone
   (America/Los_Angeles), so the time you pick is the time readers see. */
function siteNow() {
  const tz = siteData.timezone || 'America/Los_Angeles';
  // "sv-SE" gives YYYY-MM-DD HH:MM:SS, which is what datetime-local wants.
  return new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
}
function shiftSiteTime(hours) {
  const tz = siteData.timezone || 'America/Los_Angeles';
  const d = new Date(Date.now() + hours * 3600 * 1000);
  return d.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
}
function prettyWhen(v) {
  if (!v) return '';
  const [d, t] = v.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(y, m - 1, day, ...(t || '00:00').split(':').map(Number));
  return dt.toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
function renderWhen() {
  const mode = state.when || 'now';
  document.querySelectorAll('#whenChips .chip').forEach((c) => {
    c.classList.toggle('on', c.dataset.when === mode);
  });
  $('whenPicker').classList.toggle('hidden', mode === 'now');
  const tz = (siteData.timezone || 'America/Los_Angeles').split('/').pop().replace(/_/g, ' ');
  $('tzHint').textContent = `(${tz} time — the website's clock)`;
  if (mode !== 'now') {
    if (!state.whenAt) state.whenAt = mode === 'future' ? shiftSiteTime(24) : siteNow();
    $('fWhen').value = state.whenAt;
    const now = siteNow();
    let warn = '';
    if (mode === 'future' && state.whenAt <= now) warn = ' ⚠️ that time has already passed — pick a later one.';
    if (mode === 'past' && state.whenAt > now) warn = ' ⚠️ that is in the future — use “Schedule for later” instead.';
    $('whenEcho').textContent = (mode === 'future'
      ? 'Goes live automatically on ' : 'Will appear on the blog dated ') + prettyWhen(state.whenAt) + warn;
  }
  const btn = $('publishBtn');
  btn.textContent = mode === 'future' ? 'Schedule this post'
    : mode === 'past' ? 'Publish with that date' : 'Publish to christianunified.org';
}

/* ---------------------------------------------------------------- publish */
async function publish() {
  const used = usedPids();
  const pids = state.photoOrder.filter((p) => used.has(p));
  if (!state.title.trim()) { alert('Give the post a title first (step 1).'); return; }
  if (!pids.length) { alert('The post has no photos yet — drop some into rows in step 3.'); return; }
  const mode = state.when || 'now';
  if (mode !== 'now') {
    if (!state.whenAt) { alert('Pick the date and time first.'); return; }
    const now = siteNow();
    if (mode === 'future' && state.whenAt <= now) {
      alert('That time has already passed. Pick a later date and time, or choose "Publish right now".');
      return;
    }
    if (mode === 'past' && state.whenAt > now) {
      alert('That date is in the future. Use "Schedule for later" instead.');
      return;
    }
  }
  let missingAlt = pids.filter((p) => !state.photos[p].alt.trim());
  if (missingAlt.length) {
    const writeNow = confirm(
      `${missingAlt.length} photo(s) have no alt text — Google reads that text, so it's worth having.\n\n` +
      `OK  = write them all with AI now (about ${Math.ceil(missingAlt.length / 8) * 10} seconds), then publish\n` +
      `Cancel = go back to the post`);
    if (!writeNow) return;
    $('publishBtn').disabled = true;
    await writeAllAlts(true);
    $('publishBtn').disabled = false;
    missingAlt = pids.filter((p) => !state.photos[p].alt.trim());
    if (missingAlt.length &&
        !confirm(`${missingAlt.length} photo(s) still have no alt text. Publish anyway?`)) return;
  }

  const btn = $('publishBtn');
  btn.disabled = true;
  $('pubProgress').classList.remove('hidden');
  $('pubDone').classList.add('hidden');
  const setBar = (f, msg) => { $('pubBarFill').style.width = Math.round(f * 100) + '%'; $('pubStatus').textContent = msg; };
  try {
    for (let i = 0; i < pids.length; i++) {
      const p = state.photos[pids[i]];
      setBar((i / (pids.length + 1)) * 0.9, `Uploading photo ${i + 1} of ${pids.length}…`);
      if (!p.mediaId) {
        // Stamp credit, copyright and keywords into the file itself before it
        // leaves the browser — the canvas resize dropped the originals.
        const kw = [state.focusKeyword, ...(state.secondaryKeywords || []), state.location]
          .filter(Boolean).slice(0, 8);
        const withMeta = embedXmp(p.full, { description: p.alt || state.title, keywords: kw });
        const r = await api(API + '/media', {
          method: 'POST',
          body: JSON.stringify({
            filename: (p.filename || 'photo') + '.jpg',
            dataBase64: withMeta.split(',')[1],
            alt: p.alt, title: p.alt || p.filename,
            caption: p.caption || '',
            description: `${p.alt || state.title} — ${ORG}${state.location ? ', ' + state.location : ''}. Photo: ${creditOf()}.`,
          }),
        });
        p.mediaId = r.id; p.mediaUrl = r.url;
        touch();
      }
    }
    setBar(0.92, 'Creating the post on christianunified.org…');
    const html = buildPostHtml((p) => p.mediaUrl || p.full);
    const r = await api(API + '/publish', {
      method: 'POST',
      body: JSON.stringify({
        title: state.title, slug: state.slug,
        contentHtml: html,
        excerpt: state.excerpt || state.metaDesc,
        metaDesc: state.metaDesc, focusKeyword: state.focusKeyword,
        categories: state.categories,
        featuredMediaId: state.photos[state.featuredPid]?.mediaId || state.photos[pids[0]].mediaId,
        status: mode === 'future' ? 'future' : 'publish',
        ...(mode === 'now' ? {} : { date: state.whenAt + ':00' }),
      }),
    });
    state.publishedUrl = r.link;
    const scheduled = r.status === 'future';
    setBar(1, scheduled ? 'Scheduled!' : 'Done!');
    $('pubDoneTitle').textContent = scheduled
      ? `Scheduled for ${prettyWhen(state.whenAt)} 🗓`
      : "It's live! 🎉";
    $('pubDoneNote').textContent = scheduled
      ? 'WordPress will put it on the blog automatically at that time — nothing else to do.'
      : (mode === 'past' ? `Published and dated ${prettyWhen(state.whenAt)}.` : '');
    $('pubLink').textContent = r.link;
    $('pubLink').href = r.link;
    $('pubDone').classList.remove('hidden');
    touch();
  } catch (e) {
    setBar(0, '');
    $('pubStatus').textContent = 'Publishing hit a snag: ' + e.message +
      ' — nothing is lost, just press Publish again. Photos already uploaded won\'t re-upload.';
  }
  btn.disabled = false;
}

/* ----------------------------------------------------------- drafts + i/o */
async function renderDrafts() {
  const all = (await idb('readonly', (s) => s.getAll())) || [];
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  const box = $('draftsList');
  box.innerHTML = all.length ? '' : '<p class="hint">No drafts yet.</p>';
  all.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'draft-row';
    const firstPid = d.photoOrder?.[0];
    const thumb = firstPid && d.photos[firstPid] ? d.photos[firstPid].thumb : '';
    row.innerHTML = `${thumb ? `<img src="${thumb}" alt="">` : '<img alt="">'}
      <div class="meta"><div>${esc(d.title || 'Untitled post')}</div>
      <div class="d">${new Date(d.updatedAt).toLocaleString()}${d.publishedUrl ? ' · published' : ''}</div></div>
      <button class="btn">Open</button><button class="btn danger">Delete</button>`;
    const [openBtn, delBtn] = row.querySelectorAll('button');
    openBtn.onclick = () => { loadState(d); $('draftsModal').classList.add('hidden'); };
    delBtn.onclick = async () => {
      if (!confirm('Delete this draft? (The published post on the website is not affected.)')) return;
      await idb('readwrite', (s) => s.delete(d.id));
      renderDrafts();
    };
    box.appendChild(row);
  });
}

function loadState(s) {
  // Older saved drafts predate these fields.
  s.inlineLinks = s.inlineLinks || [];
  s.credit = s.credit || '';
  s.sourceFacts = s.sourceFacts || null;
  s.when = s.when || 'now';
  s.whenAt = s.whenAt || '';
  s.secondaryKeywords = s.secondaryKeywords || [];
  state = s;
  slugTouched = !!s.slug && s.slug !== slugify((s.title || '').replace(/\|/g, ' '));
  $('fTitle').value = s.title; $('fLocation').value = s.location;
  $('fCredit').value = s.credit;
  $('fSlug').value = s.slug; $('fKeyword').value = s.focusKeyword;
  $('fMetaDesc').value = s.metaDesc; metaCount();
  $('titleOptions').classList.add('hidden');
  $('pubDone').classList.toggle('hidden', !s.publishedUrl);
  if (s.publishedUrl) { $('pubLink').textContent = s.publishedUrl; $('pubLink').href = s.publishedUrl; }
  $('pubProgress').classList.add('hidden');
  localStorage.setItem('cuBlogLastDraft', s.id);
  renderCats(); renderTray(); renderBlocks(); renderChosenLinks();
  renderInlineChosen(); renderInlineSuggestions([]); renderKeywordEditor(); renderSeoCheck();
  renderWhen(); renderOutline();
}

function exportDesign() {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.slug || 'post') + '.cublog.json';
  a.click();
}
function importDesign(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const s = JSON.parse(rd.result);
      if (!s.blocks || !s.photos) throw new Error('bad file');
      s.id = s.id || crypto.randomUUID();
      loadState(s); touch();
    } catch { alert('That file doesn\'t look like a blog design.'); }
  };
  rd.readAsText(file);
}

/* ------------------------------------------------------------------ wire up */
async function init() {
  db = await openDb();
  const lastId = localStorage.getItem('cuBlogLastDraft');
  let s = lastId ? await idb('readonly', (st) => st.get(lastId)) : null;
  state = s || freshState();
  loadState(state);

  if (localStorage.getItem('cuBlogKey')) loadSite(false); else showGate();

  $('gateBtn').onclick = tryGate;
  $('gateInput').onkeydown = (e) => { if (e.key === 'Enter') tryGate(); };

  $('newPostBtn').onclick = () => { loadState(freshState()); touch(); };
  $('draftsBtn').onclick = () => { renderDrafts(); $('draftsModal').classList.remove('hidden'); };

  $('fTitle').oninput = (e) => { state.title = e.target.value; syncSlug(); touch(); renderSeoCheck(); };
  $('fLocation').oninput = (e) => { state.location = e.target.value; touch(); };
  $('fCredit').oninput = (e) => { state.credit = e.target.value; touch(); };
  $('fSlug').oninput = (e) => { slugTouched = true; state.slug = slugify(e.target.value); touch(); renderSeoCheck(); };
  $('fKeyword').oninput = (e) => { state.focusKeyword = e.target.value; touch(); renderSeoCheck(); };
  $('fMetaDesc').oninput = (e) => { state.metaDesc = e.target.value; metaCount(); touch(); renderSeoCheck(); };

  const dz = $('dropzone');
  $('browseBtn').onclick = () => $('fileInput').click();
  $('folderBtn').onclick = pickFolder;
  $('folderInput').onchange = (e) => { cull.folder = ''; startCull(e.target.files); e.target.value = ''; };
  document.querySelectorAll('.cullfilters [data-cf]').forEach((b) => b.onclick = () => {
    cull.filter = b.dataset.cf; cull.focus = 0;
    document.querySelectorAll('.cullfilters [data-cf]').forEach((x) => x.classList.toggle('on', x === b));
    renderCull();
  });
  $('cullStarBtn').onclick = () => { cull.items.forEach((it) => { if (it.rating >= 3) it.picked = true; }); renderCull(); };
  $('cullClearBtn').onclick = () => { cull.items.forEach((it) => { it.picked = false; }); renderCull(); };
  $('cullAddBtn').onclick = addPickedToPost;
  $('cullCancelBtn').onclick = () => $('cullModal').classList.add('hidden');
  $('cullViewPick').onclick = () => { const it = cullVisible()[cull.focus]; if (it) { togglePick(it); openCullView(); } };
  $('cullViewPrev').onclick = () => { setCullFocus(cull.focus - 1, true); openCullView(); };
  $('cullViewNext').onclick = () => { setCullFocus(cull.focus + 1, true); openCullView(); };
  $('cullViewClose').onclick = closeCullView;
  $('cullView').onclick = (e) => { if (e.target === $('cullView')) closeCullView(); };
  document.addEventListener('keydown', cullKeys);
  $('fileInput').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));

  document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addBlock(b.dataset.add));
  $('pasteWordsBtn').onclick = () => { $('wordsInput').value = ''; $('wordsModal').classList.remove('hidden'); $('wordsInput').focus(); };
  $('wordsGoBtn').onclick = () => { addWords($('wordsInput').value); $('wordsModal').classList.add('hidden'); };
  $('magicLayoutBtn').onclick = magicLayout;

  $('aiBtn').onclick = aiSuggest;

  // source material → opening paragraph
  const sd = $('srcDrop');
  $('srcBrowseBtn').onclick = () => $('srcInput').click();
  $('srcInput').onchange = (e) => { addSourceFiles(e.target.files); e.target.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => sd.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); sd.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => sd.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); sd.classList.remove('drag'); }));
  sd.addEventListener('drop', (e) => addSourceFiles(e.dataTransfer.files));
  $('introBtn').onclick = draftIntro;
  $('introUseBtn').onclick = useIntro;
  $('altBtn').onclick = async () => {
    $('altBtn').disabled = true;
    const n = await writeAllAlts(true);
    $('aiState').textContent = n
      ? `Alt text written for ${n} photo${n === 1 ? '' : 's'}.`
      : 'Every photo already has alt text.';
    $('altBtn').disabled = false;
  };
  $('linkSearch').oninput = renderLinkResults;
  $('extAddBtn').onclick = () => {
    const t = $('extTitle').value.trim(); let u = $('extUrl').value.trim();
    if (!t || !u) return;
    if (!/^https?:\/\//.test(u)) u = 'https://' + u;
    state.links.external.push({ title: t, url: u });
    $('extTitle').value = ''; $('extUrl').value = '';
    renderChosenLinks(); touch();
  };

  $('kwAddBtn').onclick = addKeyword;
  $('kwInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } };
  $('ilAddBtn').onclick = () => {
    const phrase = $('ilPhrase').value.trim();
    let url = ($('ilPagePick').value || $('ilUrl').value).trim();
    if (!phrase || !url) { alert('Type the words to link and choose where they should go.'); return; }
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    if (!phraseFound(phrase)) {
      alert(`“${phrase}” doesn't appear in the post text yet.\n\nThe words have to be in the post, exactly, so they can be linked.`);
      return;
    }
    addInlineLink({ phrase, url, kind: url.includes(SITE_HOST) ? 'internal' : 'external' });
    $('ilPhrase').value = ''; $('ilUrl').value = ''; $('ilPagePick').value = '';
    renderSeoCheck();
  };

  $('pmCaption').oninput = (e) => { if (modalPid) { state.photos[modalPid].caption = e.target.value; touch(); } };
  $('pmAlt').oninput = (e) => { if (modalPid) { state.photos[modalPid].alt = e.target.value; touch(); renderSeoCheck(); } };
  $('pmFilename').oninput = (e) => { if (modalPid) { state.photos[modalPid].filename = slugify(e.target.value); touch(); } };
  $('pmFeatureBtn').onclick = () => { state.featuredPid = modalPid; renderTray(); touch(); };
  $('pmAddBtn').onclick = () => {
    if (!modalPid || usedPids().has(modalPid)) return;
    // First empty slot in an existing row wins; otherwise a new single row at the end.
    let where = '';
    for (const b of state.blocks) {
      if (b.type !== 'row') continue;
      const i = b.slots.indexOf(null);
      if (i >= 0) { b.slots[i] = modalPid; where = 'into an empty slot'; break; }
    }
    if (!where) { state.blocks.push({ type: 'row', slots: [modalPid] }); where = 'as its own row at the end'; }
    $('photoModal').classList.add('hidden');
    renderBlocks(); renderTray(); touch();
    layoutNote(`Put the photo back in the post ${where}.`);
  };
  $('pmRemoveBtn').onclick = () => {
    if (!modalPid) return;
    if (!confirm('Remove this photo from the post entirely?')) return;
    state.blocks.forEach((b) => { if (b.type === 'row') b.slots = b.slots.map((p) => (p === modalPid ? null : p)); });
    state.photoOrder = state.photoOrder.filter((p) => p !== modalPid);
    delete state.photos[modalPid];
    if (state.featuredPid === modalPid) state.featuredPid = state.photoOrder[0] || null;
    $('photoModal').classList.add('hidden');
    renderTray(); renderBlocks(); touch();
  };

  document.querySelectorAll('#whenChips .chip').forEach((c) => {
    c.onclick = () => {
      state.when = c.dataset.when;
      if (state.when === 'now') state.whenAt = '';
      else state.whenAt = state.when === 'future' ? shiftSiteTime(24) : siteNow();
      renderWhen(); renderOutline(); touch();
    };
  });
  $('fWhen').oninput = (e) => { state.whenAt = e.target.value; renderWhen(); touch(); };

  $('pmAltAi').onclick = altForOnePhoto;
  $('pmCropBtn').onclick = () => {
    $('photoModal').classList.add('hidden');
    openCrop(modalPid);
  };
  $('cropApply').onclick = applyCrop;
  $('cropReset').onclick = resetCrop;
  $('cropBox').addEventListener('pointerdown', (e) => {
    const handle = e.target.dataset ? e.target.dataset.h : null;
    startCropDrag(e, handle || 'move');
  });
  window.addEventListener('resize', () => {
    if (!$('cropModal').classList.contains('hidden')) drawCrop();
  });

  $('rcAlone').onclick = () => resolveRowChoice('alone');
  $('rcSwap').onclick = () => resolveRowChoice('swap');
  $('rcUndo').onclick = () => resolveRowChoice('undo');

  $('previewBtn').onclick = showPreview;
  $('publishBtn').onclick = publish;
  $('exportBtn').onclick = exportDesign;
  $('importBtn').onclick = () => $('importInput').click();
  $('importInput').onchange = (e) => { if (e.target.files[0]) importDesign(e.target.files[0]); e.target.value = ''; };

  document.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => $(b.dataset.close).classList.add('hidden'));
}

init();
