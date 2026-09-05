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
const MAX_EDGE = 2560;      // long edge of published photos
const THUMB_EDGE = 420;     // tray thumbnails (also sent to the AI)
const JPEG_Q = 0.92;
const THUMB_Q = 0.8;
const MAX_UPLOAD_BYTES = 11_500_000;   // the backend refuses anything over 12 MB
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
    publishedUrl: '', publishedId: 0,
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

/* ------------------------------------------------------------------ undo
   Every layout change (rows, order, links) is snapshotted so ⌘Z / the ↶
   button can walk back through the last 40 of them. */
const undoStack = [];
let lastLayoutJson = null;
const layoutJson = () => JSON.stringify({ b: state.blocks, l: state.links, i: state.inlineLinks });
function resetUndo() { undoStack.length = 0; lastLayoutJson = layoutJson(); renderUndoBtn(); }
function recordUndo() {
  const now = layoutJson();
  if (lastLayoutJson !== null && now !== lastLayoutJson) {
    undoStack.push(lastLayoutJson);
    if (undoStack.length > 40) undoStack.shift();
  }
  lastLayoutJson = now;
  renderUndoBtn();
}
function undoLayout() {
  const prev = undoStack.pop();
  if (!prev) return;
  const snap = JSON.parse(prev);
  state.blocks = snap.b; state.links = snap.l; state.inlineLinks = snap.i;
  lastLayoutJson = prev;
  renderBlocks(); renderTray(); renderChosenLinks(); renderInlineChosen();
  renderUndoBtn(); renderProgress();
  layoutNote('Undone.');
  // Save without re-recording this as a new step.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await idb('readwrite', (st) => st.put(JSON.parse(JSON.stringify(state))));
    $('saveState').textContent = 'saved';
  }, 300);
}
function renderUndoBtn() {
  const b = $('undoBtn'); if (!b) return;
  b.disabled = !undoStack.length;
  b.title = undoStack.length ? `Undo the last change (${undoStack.length} available) — ⌘Z` : 'Nothing to undo yet';
}

/* The strip at the top: where you are, what's done, what's still missing. */
function progressFacts() {
  const used = usedPids();
  const placed = state.photoOrder.filter((p) => used.has(p));
  const unused = state.photoOrder.length - placed.length;
  const words = state.blocks.filter((b) => b.type === 'text' && b.text.trim()).length;
  const noAlt = placed.filter((p) => !(state.photos[p].alt || '').trim()).length;
  return {
    title: !!state.title.trim(),
    photos: state.photoOrder.length,
    placed: placed.length, unused,
    rows: state.blocks.filter((b) => b.type === 'row' && b.slots.some(Boolean)).length,
    words,
    meta: !!(state.metaDesc || '').trim(),
    keyword: !!(state.focusKeyword || '').trim(),
    noAlt,
    lonely: loneVerticalRows().length,
    cats: state.categories.length,
    published: !!state.publishedUrl,
  };
}
function renderProgress() {
  const el = $('progress'); if (!el) return;
  const f = progressFacts();
  const set = (step, status, text) => {
    const li = el.querySelector(`[data-step="${step}"]`); if (!li) return;
    li.className = 'pstep ' + status;
    li.querySelector('.pnote').textContent = text;
  };
  const n = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  set('stepDetails', f.title ? 'done' : 'todo', f.title ? state.title.slice(0, 34) : 'needs a title');
  set('stepPhotos', f.photos ? 'done' : 'todo', f.photos ? n(f.photos, 'photo') : 'add photos');
  set('stepLayout',
    !f.rows ? 'todo' : (f.unused || f.lonely || !f.words ? 'warn' : 'done'),
    !f.rows ? 'lay out the photos'
      : f.lonely ? `${f.lonely} vertical alone`
      : f.unused ? `${n(f.unused, 'photo')} not in the post`
      : !f.words ? 'photos placed · no words yet'
      : `${n(f.placed, 'photo')} · ${n(f.words, 'paragraph')}`);
  set('stepSeo',
    (f.meta && f.keyword && !f.noAlt) ? 'done' : (f.meta || f.keyword ? 'warn' : 'todo'),
    !f.meta ? 'no description yet' : f.noAlt ? `${f.noAlt} missing alt text` : !f.keyword ? 'no keyword' : 'ready');
  set('stepPublish', f.published ? 'done' : 'todo', f.published ? 'published' : 'check & publish');
}

function touch() {
  state.updatedAt = Date.now();
  recordUndo();
  renderProgress();
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


/* ----------------------------------------------------------------- imaging
   Photos have to hold up when someone zooms in, so they go through the same
   recipe as Amy's wall-art print script: resample properly, sharpen, then save
   at a high JPEG quality.

   What used to make them soft was one `drawImage` straight from a ~6000 px file
   down to the published size. Bilinear filtering only reads a 2x2 patch per
   output pixel, so at a 3x reduction most of the frame is simply thrown away —
   the result is mush, and nothing sharpened it afterwards. Halving repeatedly
   averages every source pixel in, which is what LANCZOS buys you in the print
   script, and the unsharp mask puts back the bite that any resample costs. */

const CAN_BLUR = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    c.filter = 'blur(1px)';
    return c.filter === 'blur(1px)';
  } catch { return false; }
})();

function smoothCtx(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/* Downsize `img` (optionally a source rect) into a canvas of exactly dw x dh,
   never shrinking by more than half in one step. The first step draws straight
   from the source, so we never hold a canvas the size of the original. */
function stepDown(img, sx, sy, sw, sh, dw, dh) {
  const sizes = [];
  let cw = Math.max(1, Math.round(sw)), ch = Math.max(1, Math.round(sh));
  while (cw > dw * 2 && ch > dh * 2) {
    cw = Math.max(dw, Math.round(cw / 2));
    ch = Math.max(dh, Math.round(ch / 2));
    sizes.push([cw, ch]);
  }
  const last = sizes[sizes.length - 1];
  if (!last || last[0] !== dw || last[1] !== dh) sizes.push([dw, dh]);

  let cur = null, pw = 0, ph = 0;
  for (const [w, h] of sizes) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = smoothCtx(c);
    if (cur) ctx.drawImage(cur, 0, 0, pw, ph, 0, 0, w, h);
    else ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    cur = c; pw = w; ph = h;
  }
  return cur;
}

/* PIL's UnsharpMask, done with the canvas's own (native, fast) blur: add back
   `percent` of the difference between the photo and a blurred copy, but only
   where that difference is real detail rather than sensor noise. */
function unsharp(canvas, radius, percent, threshold) {
  if (!CAN_BLUR) return;          // very old browser: leave the photo as it is
  const w = canvas.width, h = canvas.height;
  const pad = Math.max(2, Math.ceil(radius * 3));

  // Blurring samples transparent pixels past the canvas edge, which would leave
  // a bright rim all the way round. Pad with the edge pixels stretched outwards,
  // blur that, and read back only the middle.
  const pc = document.createElement('canvas');
  pc.width = w + pad * 2; pc.height = h + pad * 2;
  const px = pc.getContext('2d');
  px.drawImage(canvas, 0, 0, 1, h, 0, pad, pad, h);
  px.drawImage(canvas, w - 1, 0, 1, h, w + pad, pad, pad, h);
  px.drawImage(canvas, 0, 0, w, 1, pad, 0, w, pad);
  px.drawImage(canvas, 0, h - 1, w, 1, pad, h + pad, w, pad);
  px.drawImage(canvas, 0, 0, 1, 1, 0, 0, pad, pad);
  px.drawImage(canvas, w - 1, 0, 1, 1, w + pad, 0, pad, pad);
  px.drawImage(canvas, 0, h - 1, 1, 1, 0, h + pad, pad, pad);
  px.drawImage(canvas, w - 1, h - 1, 1, 1, w + pad, h + pad, pad, pad);
  px.drawImage(canvas, pad, pad);

  const bc = document.createElement('canvas');
  bc.width = pc.width; bc.height = pc.height;
  const bx = bc.getContext('2d');
  bx.filter = `blur(${radius}px)`;
  bx.drawImage(pc, 0, 0);

  const ctx = canvas.getContext('2d');
  const shot = ctx.getImageData(0, 0, w, h);
  const soft = bx.getImageData(pad, pad, w, h).data;
  // Channels are unrolled and the alpha byte skipped — this runs over several
  // million pixels per photo. Writing into a Uint8ClampedArray clamps for us.
  const a = shot.data, amt = percent / 100, t = threshold, len = a.length;
  for (let i = 0; i < len; i += 4) {
    let d = a[i] - soft[i];
    if (d >= t || d <= -t) a[i] += amt * d;
    d = a[i + 1] - soft[i + 1];
    if (d >= t || d <= -t) a[i + 1] += amt * d;
    d = a[i + 2] - soft[i + 2];
    if (d >= t || d <= -t) a[i + 2] += amt * d;
  }
  ctx.putImageData(shot, 0, 0);
}

/* The print script uses UnsharpMask(radius 1.0-1.4, 70%, threshold 3) at 300
   dpi. Screen pixels are bigger than print dots, so the radius comes down a
   touch; the amount and threshold are Amy's. */
function sharpenFor(longEdge) {
  if (longEdge >= 2000) return { radius: 1.0, percent: 70, threshold: 3 };
  if (longEdge >= 900) return { radius: 0.8, percent: 70, threshold: 3 };
  return { radius: 0.6, percent: 60, threshold: 3 };
}

const jpegBytes = (dataUrl) =>
  Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);

/* One published-quality JPEG from `img`, optionally cropped to a source rect. */
function renderJpeg(img, edge, q, rect) {
  const sx = rect ? rect.sx : 0;
  const sy = rect ? rect.sy : 0;
  const sw = rect ? rect.sw : (img.naturalWidth || img.width);
  const sh = rect ? rect.sh : (img.naturalHeight || img.height);
  const sc = Math.min(1, edge / Math.max(sw, sh));      // never blow a photo up
  const dw = Math.max(1, Math.round(sw * sc));
  const dh = Math.max(1, Math.round(sh * sc));
  const c = stepDown(img, sx, sy, sw, sh, dw, dh);
  const s = sharpenFor(Math.max(dw, dh));
  unsharp(c, s.radius, s.percent, s.threshold);
  let url = c.toDataURL('image/jpeg', q);
  // A very busy frame at this quality can approach the backend's 12 MB ceiling;
  // ease the quality back rather than fail halfway through publishing.
  for (let qq = q - 0.05; jpegBytes(url) > MAX_UPLOAD_BYTES && qq >= 0.72; qq -= 0.05) {
    url = c.toDataURL('image/jpeg', qq);
  }
  return { url, w: dw, h: dh };
}

/* Resampling and sharpening cost real work, so imports go through one at a time
   with a breath in between — the tray still fills in as photos land. */
let importQueue = Promise.resolve();
function queueImport(job) {
  importQueue = importQueue
    .then(job)
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, 0)));
  return importQueue;
}

/* A crop should be cut from the original file, not from a JPEG we already made
   — re-encoding a re-encode is where sharpness quietly goes. Originals are only
   kept for the session that imported them; a draft reopened later falls back to
   the published copy, which is now full size and high quality anyway. */
const origFiles = new Map();   // pid -> the untouched File
const origUrls = new Map();    // pid -> an object URL for it

function forgetOriginal(pid) {
  const u = origUrls.get(pid);
  if (u) URL.revokeObjectURL(u);
  origUrls.delete(pid); origFiles.delete(pid);
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
  const f = origFiles.get(pid);
  if (f) {
    if (!origUrls.has(pid)) origUrls.set(pid, URL.createObjectURL(f));
    return origUrls.get(pid);
  }
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
      const rect = {
        sx: Math.round(box.x * iw), sy: Math.round(box.y * ih),
        sw: Math.max(1, Math.round(box.w * iw)), sh: Math.max(1, Math.round(box.h * ih)),
      };
      const full = renderJpeg(img, MAX_EDGE, JPEG_Q, rect);
      const thumb = renderJpeg(img, THUMB_EDGE, THUMB_Q, rect);
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
    p.thumb = renderJpeg(img, THUMB_EDGE, THUMB_Q).url;
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
  p.thumb = renderJpeg(img, THUMB_EDGE, THUMB_Q).url;
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
    queueImport(() => new Promise((done) => {
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = () => {
        const full = renderJpeg(img, MAX_EDGE, JPEG_Q);
        const thumb = renderJpeg(img, THUMB_EDGE, THUMB_Q);
        const pid = crypto.randomUUID();
        state.photos[pid] = {
          id: pid,
          filename: slugify(f.name.replace(/\.[^.]+$/, '')) || 'photo',
          alt: '', caption: '', w: full.w, h: full.h,
          full: full.url, thumb: thumb.url,
          mediaId: null, mediaUrl: null,
        };
        // Hold on to the file itself so a later crop is cut from the original.
        origFiles.set(pid, f);
        state.photoOrder.push(pid);
        if (!state.featuredPid) state.featuredPid = pid;
        URL.revokeObjectURL(url);
        renderTray(); touch();
        readTakenAt(f).then((ts) => { if (state.photos[pid]) { state.photos[pid].takenAt = ts; touch(); } });
        done();
      };
      img.onerror = () => { URL.revokeObjectURL(url); done(); };
      img.src = url;
    }));
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
const CULL_VERSION = 'v9';   // shown in the cull header so support can tell which build is running

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
    if (old) {
      // Same folder reopened (e.g. after making it available offline): keep the
      // pick, but re-read the file — it may have content now that it didn't before.
      if (old.url) { URL.revokeObjectURL(old.url); old.url = ''; }
      old.file = e.file; old.ratedChecked = false; old.unreadable = false;
      return old;
    }
    return { key, file: e.file, path: e.path, name: e.path.split('/').pop(),
      url: '', rating: 0, label: '', ratedChecked: false, picked: false };
  });
  // object URLs for anything from an earlier folder are no longer needed
  prev.forEach((it) => { if (!cull.items.includes(it) && it.url) { URL.revokeObjectURL(it.url); it.url = ''; } });
  cull.filter = 'all'; cull.focus = 0;
  document.querySelectorAll('.cullfilters [data-cf]').forEach((b) => b.classList.toggle('on', b.dataset.cf === 'all'));
  $('cullTitle').textContent = `Pick the photos for this post — ${cull.folder}`;
  $('cullModal').classList.remove('hidden');
  renderCull();
  readCullRatings();
}
/* The tile shows the file itself. The browser decodes and scales lazily, only
   for tiles on screen — no canvases, no thumbnail generation, and it's
   instant even for a few hundred full-res camera files. */
function urlFor(it) { if (!it.url) it.url = URL.createObjectURL(it.file); return it.url; }
async function readCullRatings() {
  const pending = cull.items.filter((it) => !it.ratedChecked);
  let done = 0;
  const say = () => { $('cullHint').textContent = pending.length && done < pending.length
    ? `${cull.items.length} photos · checking star ratings ${done}/${pending.length}… · ${CULL_VERSION}`
    : `${cull.items.length} photos · ${cull.items.filter((i) => i.rating > 0).length} rated · ${CULL_VERSION}`; };
  say();
  const worker = async () => {
    while (pending.length) {
      const it = pending.shift();
      try {
        it.unreadable = !(await looksLikeImage(it.file));
        if (!it.unreadable) ({ rating: it.rating, label: it.label } = await readXmpRating(it.file));
      } catch { /* unrated */ }
      it.ratedChecked = true; done++;
      if (it.rating > 0 || it.unreadable) { const tile = document.querySelector(`.ctile[data-key="${CSS.escape(it.key)}"]`); if (tile) paintTile(tile, it); }
      if (done % 20 === 0 || !pending.length) { say(); updateCullButtons(); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  say(); updateCullButtons();
  const bad = cull.items.filter((it) => it.unreadable).length;
  if (bad) {
    $('cullHint').innerHTML = `<strong style="color:#b23b3b">${bad} of ${cull.items.length} photos can't be read</strong> — ` +
      `they look like Dropbox <em>online-only</em> placeholders (cloud icon in Finder). ` +
      `In Finder, right-click the folder → <strong>Make Available Offline</strong>, wait for the download, then pick the folder again. · ${CULL_VERSION}`;
  }
}
/* Real JPEG / PNG / WebP files start with a signature. A Dropbox online-only
   placeholder, or anything else that isn't really an image, doesn't. */
async function looksLikeImage(file) {
  if (!file.size) return false;
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0xFF && b[1] === 0xD8) return true;                                    // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;  // PNG
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return true; // WebP
  return false;
}
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
  tile.className = 'ctile' + (it.picked ? ' picked' : '') + (cull.added.has(it.key) ? ' inpost' : '') + (it.unreadable ? ' unreadable' : '');
  tile.innerHTML = (it.unreadable
      ? `<span class="pend">⚠️ not downloaded<br><small>online-only in Dropbox</small></span>`
      : `<img src="${urlFor(it)}" alt="" draggable="false" loading="lazy" decoding="async">`) +
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

/* ---- 100% inspection in the big view -------------------------------------
   The tiles are small; checking whether an eye is sharp needs real pixels. */
let cullZoomed = false;
let cullPan = { x: 0.5, y: 0.5 };     // where in the photo we're looking (0-1)

function setCullZoom(on, origin) {
  cullZoomed = !!on;
  const img = $('cullViewImg');
  const wrap = $('cullView');
  if (origin) cullPan = origin;
  wrap.classList.toggle('zoomed', cullZoomed);
  if (!cullZoomed) {
    img.style.transform = '';
    img.style.transformOrigin = '';
    $('cullZoomHint').textContent = 'Space = zoom to 100%';
    return;
  }
  applyCullPan();
  const nat = img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : '';
  $('cullZoomHint').textContent = `100%${nat ? ' · ' + nat : ''} · drag to look around · Space to zoom out`;
}

function applyCullPan() {
  const img = $('cullViewImg');
  if (!cullZoomed || !img.naturalWidth) return;
  // Scale so one image pixel maps to one screen pixel.
  const shown = img.getBoundingClientRect();
  const fitW = shown.width || 1;
  const scale = Math.max(1, img.naturalWidth / fitW);
  img.style.transformOrigin = `${(cullPan.x * 100).toFixed(2)}% ${(cullPan.y * 100).toFixed(2)}%`;
  img.style.transform = `scale(${scale.toFixed(3)})`;
}

function wireCullZoom() {
  const img = $('cullViewImg');
  // Click the photo to zoom in at that spot; click again to zoom out.
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    if (cullZoomed) { setCullZoom(false); return; }
    setCullZoom(true, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  });
  // Drag to look around while zoomed.
  img.addEventListener('pointerdown', (e) => {
    if (!cullZoomed) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const from = { ...cullPan };
    const r = img.getBoundingClientRect();
    const move = (ev) => {
      cullPan = {
        x: Math.min(Math.max(from.x - (ev.clientX - startX) / r.width, 0), 1),
        y: Math.min(Math.max(from.y - (ev.clientY - startY) / r.height, 0), 1),
      };
      applyCullPan();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  img.addEventListener('load', () => { if (cullZoomed) applyCullPan(); });
}

function openCullView() {
  const vis = cullVisible(); const it = vis[cull.focus];
  if (!it) return;
  $('cullView').classList.remove('hidden');
  $('cullViewName').textContent = `${it.name}${it.rating ? '  ' + '★'.repeat(it.rating) : ''}`;
  $('cullViewPick').textContent = it.picked ? '✓ Picked' : 'Pick';
  $('cullViewPick').classList.toggle('on', it.picked);
  $('cullViewImg').src = urlFor(it);
  setCullZoom(false);
}
function closeCullView() { setCullZoom(false); $('cullView').classList.add('hidden'); setCullFocus(cull.focus, true); }
function addPickedToPost() {
  const keep = cull.items.filter((it) => it.picked && !cull.added.has(it.key) && !it.unreadable);
  const skipped = cull.items.filter((it) => it.picked && !cull.added.has(it.key) && it.unreadable).length;
  if (skipped) alert(`${skipped} picked photo${skipped === 1 ? ' is' : 's are'} online-only in Dropbox and can't be read yet — make the folder available offline, then add ${skipped === 1 ? 'it' : 'them'}.`);
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
  if ((k === 'p' || k === 'P') && it) { e.preventDefault(); togglePick(it); if (viewing) openCullView(); return; }
  // Space checks focus the way Lightroom does: jump to the big view and go
  // straight to 100%, then toggle back out. Picking stays on P / X.
  if (k === ' ' && it) {
    e.preventDefault();
    if (!viewing) { openCullView(); setCullZoom(true); }
    else setCullZoom(!cullZoomed);
    return;
  }
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
    const si = selIndex(pid);
    d.className = 'thumb' + (used.has(pid) ? ' used' : '') + (si >= 0 ? ' sel' : '');
    d.draggable = true;
    d.addEventListener('dragstart', (e) => startPhotoDrag(e, pid));
    d.addEventListener('dragend', endPhotoDrag);
    d.innerHTML = `<img src="${p.thumb}" alt="" draggable="false">` +
      (state.featuredPid === pid ? '<span class="star">★</span>' : '') +
      (p.crop ? `<span class="cropped">${p.cropRatio === 1 ? 'square' : 'cropped'}</span>` : '') +
      (si >= 0 ? `<span class="selnum">${si + 1}</span>` : '') +
      (used.has(pid) ? '<span class="flag">in post</span>' : '');
    d.onclick = (e) => {
      // Shift/⌘/Ctrl-click selects; a plain click while building a diptych or
      // triptych also selects; otherwise open the photo's details.
      if (e.shiftKey || e.metaKey || e.ctrlKey || (sel.target && !used.has(pid))) { e.preventDefault(); toggleSel(pid); return; }
      openPhotoModal(pid);
    };
    tray.appendChild(d);
  });
  renderSelBar();
}

/* ------------------------------------ select several, add them as one row
   Shift-click (or ⌘-click) photos in the tray to pick them in order, then one
   button adds them as a single row — solo, diptych, triptych or four across
   — or as rows of 2–3 when there are more. "Start a diptych…" from a photo's
   details window does the same with a target size, so plain clicks in the
   tray fill it and the row builds itself. */
const sel = { pids: [], target: 0 };
const ROW_NAMES = { 1: 'solo', 2: 'a diptych', 3: 'a triptych', 4: 'four across' };
function selIndex(pid) { return sel.pids.indexOf(pid); }
function toggleSel(pid) {
  if (usedPids().has(pid)) {
    $('photoState').textContent = 'That one is already in the post. To put another photo beside it, hover its row down in step 3 and click ＋.';
    return;
  }
  const i = selIndex(pid);
  if (i >= 0) sel.pids.splice(i, 1); else sel.pids.push(pid);
  renderTray();
  if (sel.target && sel.pids.length >= sel.target) commitSel('row');
}
function clearSel() { sel.pids = []; sel.target = 0; renderTray(); }
function renderSelBar() {
  const bar = $('selBar'); if (!bar) return;
  const used = usedPids();
  sel.pids = sel.pids.filter((p) => state.photos[p] && !used.has(p));
  const n = sel.pids.length;
  if (!n && !sel.target) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  if (sel.target && n < sel.target) {
    const need = sel.target - n;
    $('selText').textContent = `Pick ${need} more photo${need === 1 ? '' : 's'} for ${ROW_NAMES[sel.target]} — just click them in the tray.`;
  } else {
    $('selText').textContent = `${n} photo${n === 1 ? '' : 's'} selected, in the order you clicked.`;
  }
  const rowBtn = $('selRowBtn');
  rowBtn.textContent = n <= 4 ? `Add as ${ROW_NAMES[n] || 'a row'}` : `Add as rows (${n} photos)`;
  rowBtn.disabled = n === 0;
  $('selEachBtn').hidden = n < 2;
}
/* 5+ photos: rows of 3 and 2, never stranding one on its own. */
function chunkRows(pids) {
  const out = []; const q = pids.slice();
  while (q.length) {
    let n = Math.min(3, q.length);
    if (q.length - n === 1) n -= 1;
    out.push(q.splice(0, Math.max(1, n)));
  }
  return out;
}
function commitSel(mode) {
  const used = usedPids();
  const pids = sel.pids.filter((p) => state.photos[p] && !used.has(p));
  if (!pids.length) { clearSel(); return; }
  const rows = mode === 'each' ? pids.map((p) => [p]) : pids.length <= 4 ? [pids] : chunkRows(pids);
  rows.forEach((r) => state.blocks.push({ type: 'row', slots: r }));
  const what = rows.length === 1 ? (ROW_NAMES[rows[0].length] || 'a row') : `${rows.length} rows`;
  sel.pids = []; sel.target = 0;
  renderBlocks(); renderTray(); touch();
  layoutNote(`Added ${pids.length} photo${pids.length === 1 ? '' : 's'} as ${what}, at the end of the post.`);
}
function startRowFrom(pid, target) {
  if (!pid || usedPids().has(pid)) return;
  sel.pids = [pid]; sel.target = target;
  $('photoModal').classList.add('hidden');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // so Esc works right away
  renderTray();
  $('stepPhotos').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ----------------------------------------------------------- capture time
   EXIF DateTimeOriginal (0x9003), read from the first 128 KB of the file, so
   the automatic layout can run in the order the photos were taken. Falls
   back to the file's modified time. */
async function readTakenAt(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, 131072).arrayBuffer());
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return file.lastModified || 0;
    const dv = new DataView(buf.buffer);
    let i = 2;
    while (i + 4 < buf.length && buf[i] === 0xFF) {
      const marker = buf[i + 1], len = (buf[i + 2] << 8) | buf[i + 3];
      if (marker === 0xDA) break;                                   // image data — no EXIF
      if (marker === 0xE1 && buf[i + 4] === 0x45 && buf[i + 5] === 0x78 && buf[i + 6] === 0x69 && buf[i + 7] === 0x66) {
        const t = i + 10;                                           // TIFF header
        const le = buf[t] === 0x49;
        const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
        const findTag = (ifd, tag) => { const n = u16(ifd); for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === tag) return e; } return -1; };
        const ifd0 = t + u32(t + 4);
        let e = -1;
        const exifPtr = findTag(ifd0, 0x8769);
        if (exifPtr >= 0) e = findTag(t + u32(exifPtr + 8), 0x9003);   // DateTimeOriginal
        if (e < 0) e = findTag(ifd0, 0x0132);                            // DateTime
        if (e >= 0) {
          const cnt = u32(e + 4);
          const off = cnt > 4 ? t + u32(e + 8) : e + 8;
          const str = String.fromCharCode(...buf.subarray(off, off + Math.min(cnt, 19)));
          const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
          if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        }
        break;
      }
      i += 2 + len;
    }
  } catch { /* malformed EXIF — fall through */ }
  return file.lastModified || 0;
}
/* Oldest first; photos with no capture time keep their drop order, after. */
function sortByTaken(pids) {
  const idx = new Map(state.photoOrder.map((p, i) => [p, i]));
  const key = (p) => (state.photos[p].takenAt || 0) || (9e15 + idx.get(p));
  return pids.slice().sort((x, y) => key(x) - key(y));
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
    const havePhotos = state.photoOrder.length > 0;
    box.innerHTML = `<div class="empty-layout">
      <p><strong>${havePhotos ? 'Your photos are in — now lay them out.' : 'Nothing here yet.'}</strong></p>
      <p class="hint">${havePhotos
        ? 'One press arranges them in rows — solos, pairs and triptychs, in the order they were taken. Then drag any photo to move it.'
        : 'Add photos in step 2 first; then one press lays them all out for you.'}</p>
      <button class="btn primary big" id="${havePhotos ? 'emptyLayoutBtn' : 'emptyPhotosBtn'}">${havePhotos ? '✨ Lay the photos out for me' : '↑ Add photos'}</button>
      <p class="hint">${havePhotos ? 'Or drag a photo from the tray straight down here.' : ''}</p>
    </div>`;
    const eb = $('emptyLayoutBtn'); if (eb) eb.onclick = magicLayout;
    const pb = $('emptyPhotosBtn'); if (pb) pb.onclick = () => $('stepPhotos').scrollIntoView({ behavior: 'smooth' });
  }
  state.blocks.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'block';
    const rowFull = b.type === 'row' && b.slots.length >= 4;
    const rowTool = b.type === 'row'
      ? `<button title="${rowFull ? 'This row already holds four' : 'Add another photo to this row'}" data-act="add"${rowFull ? ' disabled' : ''}>＋</button>
         <button title="Mix it — shuffle the photos in this row" data-act="mix">⇄</button>
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
        wireSlot(slot, b, si, pid);
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
        if (act === 'add') {
          if (b.slots.length >= 4) { layoutNote('A row holds at most four photos.'); return; }
          b.slots.push(null);
          renderBlocks();
          openPicker(b, b.slots.length - 1);
          touch();
          return;
        }
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

/* ------------------------------------------------- drag the photos too
   A photo can be picked up from the tray or from any row and dropped:
   onto another photo (joins that row, before or after it), onto an empty
   slot (fills it), onto a row or text block (its own new row above/below),
   or under the last block (a new row at the end). A photo is only ever in
   one place, so moving never duplicates. */
let dragPid = null;

function takeOutOfRows(pid) {
  state.blocks.forEach((blk) => {
    if (blk.type === 'row') blk.slots = blk.slots.map((q) => (q === pid ? null : q));
  });
  // A row emptied by the move disappears; a row that still has photos keeps
  // any gap closed up so nothing is left dangling.
  state.blocks = state.blocks.filter((blk) => blk.type !== 'row' || blk.slots.some(Boolean));
  state.blocks.forEach((blk) => { if (blk.type === 'row') blk.slots = blk.slots.filter(Boolean); });
}

function afterPhotoLanded(block) {
  // Amy's rule still applies to hand-made rows: a vertical never sits alone.
  const filled = block.slots.filter(Boolean);
  if (filled.length === 1 && isVertical(filled[0]) && !mustStandAlone(filled[0])) {
    block.slots.push(null);
    layoutNote('Verticals are never shown alone — drop a second photo into that row.');
  }
}

function startPhotoDrag(e, pid) {
  e.stopPropagation();                 // don't let the whole row start dragging too
  dragPid = pid;
  dragFrom = null;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', 'photo:' + pid); } catch { /* Safari */ }
  document.body.classList.add('dragging-photo');
}
function endPhotoDrag() {
  dragPid = null;
  document.body.classList.remove('dragging-photo');
  clearDragMarks();
}

/* A photo slot: draggable (if filled) and a drop target either way. */
function wireSlot(slot, block, index, pid) {
  if (pid) {
    slot.draggable = true;
    slot.addEventListener('dragstart', (e) => startPhotoDrag(e, pid));
    slot.addEventListener('dragend', endPhotoDrag);
  }
  slot.addEventListener('dragover', (e) => {
    if (!dragPid || dragPid === pid) return;
    e.preventDefault(); e.stopPropagation();
    const r = slot.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    slot.classList.toggle('drop-fill', !pid);
    slot.classList.toggle('drop-left', !!pid && !after);
    slot.classList.toggle('drop-right', !!pid && after);
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('drop-left', 'drop-right', 'drop-fill'));
  slot.addEventListener('drop', (e) => {
    if (!dragPid || dragPid === pid) return;
    e.preventDefault(); e.stopPropagation();
    const moving = dragPid;
    const r = slot.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    const filledNow = block.slots.filter(Boolean).length;
    const alreadyHere = block.slots.includes(moving);
    if (!pid) {
      takeOutOfRows(moving);
      block.slots[index] = moving;
      if (!state.blocks.includes(block)) state.blocks.push(block);
    } else {
      if (!alreadyHere && filledNow >= 4) { layoutNote('A row holds at most four photos.'); endPhotoDrag(); return; }
      takeOutOfRows(moving);
      // takeOutOfRows may have re-packed this row; find the target again.
      let at = block.slots.indexOf(pid);
      if (at < 0) at = block.slots.length;
      block.slots.splice(at + (after ? 1 : 0), 0, moving);
      if (!state.blocks.includes(block)) state.blocks.push(block);
    }
    afterPhotoLanded(block);
    endPhotoDrag();
    renderBlocks(); renderTray(); touch();
  });
}

/* Dropping a photo onto a row or text block (not onto a photo) makes a new
   single-photo row above or below it. */
function dropPhotoAsNewRow(index, after) {
  const moving = dragPid;
  takeOutOfRows(moving);
  const row = { type: 'row', slots: [moving] };
  const at = Math.min(index + (after ? 1 : 0), state.blocks.length);
  state.blocks.splice(at, 0, row);
  afterPhotoLanded(row);
  endPhotoDrag();
  renderBlocks(); renderTray(); touch();
}

function clearDragMarks() {
  document.querySelectorAll('.block, .omini').forEach((b) =>
    b.classList.remove('dragging', 'over-top', 'over-bottom', 'photo-drop'));
  document.querySelectorAll('.slot').forEach((sl) =>
    sl.classList.remove('drop-left', 'drop-right', 'drop-fill'));
  const blocks = $('blocks'); if (blocks) blocks.classList.remove('photo-drop-end');
}

/* Used by both the full blocks and the little outline, so a block can be picked
   up in either one and dropped in the other. */
function wireDrag(el, index) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (dragPid) return;               // a photo inside this block is what's moving
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
    if (dragFrom === null && !dragPid) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    el.classList.toggle('photo-drop', !!dragPid);
    el.classList.toggle('over-bottom', after);
    el.classList.toggle('over-top', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('over-top', 'over-bottom', 'photo-drop'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over-top', 'over-bottom', 'photo-drop');
    const r = el.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    if (dragPid) { dropPhotoAsNewRow(index, after); return; }
    if (dragFrom === null) return;
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
      // Already in the post? Take it out of its old spot rather than showing
      // the same photo twice.
      state.blocks.forEach((blk) => {
        if (blk.type !== 'row') return;
        blk.slots = blk.slots.map((q) => (q === pid ? null : q));
      });
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
/* Work out where the paragraphs are. Blank lines between them is the tidy
   case; plenty of pasted copy only has single line breaks, and that used to
   collapse into one enormous block. Hard-wrapped prose (lines that stop
   mid-sentence) is rejoined rather than shattered into fragments. */
function splitParagraphs(raw) {
  const byBlank = String(raw || '').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
  const flatten = (t) => t.replace(/\s*\n\s*/g, ' ');
  if (byBlank.length > 1) return byBlank.map(flatten);

  const lines = String(raw || '').split(/\n+/).map((t) => t.trim()).filter(Boolean);
  if (lines.length < 2) return byBlank.map(flatten);
  // If most lines don't finish a sentence, they're wrapped, not separate paragraphs.
  const finished = lines.filter((l) => /[.!?"'\u2019\u201d)]$/.test(l)).length;
  if (finished / lines.length < 0.6) return byBlank.map(flatten);
  return lines;
}

function addWords(raw) {
  const paras = splitParagraphs(raw);
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
  // Amy's rules: lay out in the order the photos were taken, open on a solo
  // photo and close on a solo photo. A solo should be a horizontal when one is
  // among the first/last three; otherwise the vertical stands alone.
  const free = sortByTaken(state.photoOrder.filter((pid) => !used.has(pid)));
  if (!free.length) return;
  const takeSolo = (fromEnd) => {
    const win = fromEnd ? free.slice(-3).reverse() : free.slice(0, 3);
    const pick = win.find((p) => !isVertical(p)) || win[0];
    free.splice(free.indexOf(pick), 1);
    return pick;
  };
  const opener = takeSolo(false);
  const closer = free.length ? takeSolo(true) : null;
  // Sizes to reach for, in order, purely for visual rhythm. Starts at a pair
  // so the middle doesn't open with a second solo right after the opener.
  const pattern = [1, 2, 3, 2, 1, 3, 2, 2];
  const rows = [];
  let pi = 1;
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
  state.blocks.push({ type: 'row', slots: [opener] });
  // The photo that opens the post is the natural featured image — unless the
  // writer has starred one on purpose.
  if (!state.featuredChosen) state.featuredPid = opener;
  rows.forEach((r) => state.blocks.push(r));
  if (closer) state.blocks.push({ type: 'row', slots: [closer] });
  renderBlocks(); renderTray(); touch();
  layoutNote(`Laid out ${1 + rows.reduce((n, r) => n + r.slots.length, 0) + (closer ? 1 : 0)} photos in the order they were taken — opening and closing on a solo.`);
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
  $('introBtn').disabled = !sourceDocs.length && !($('srcNotes') && $('srcNotes').value.trim());
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
      // Still 1600px, but resampled and sharpened the same way as post photos:
      // small text in a phone snap survives that and turns to mush without it.
      sourceDocs.push({ id: crypto.randomUUID(), name: f.name, mediaType: 'image/jpeg',
        dataBase64: renderJpeg(img, 1600, 0.85).url.split(',')[1],
        thumb: renderJpeg(img, 120, 0.7).url });
      URL.revokeObjectURL(img.src);
      renderSourceDocs();
    };
    img.src = URL.createObjectURL(f);
  });
}
let lastIntro = null;
async function draftIntro() {
  const notes = ($('srcNotes').value || '').trim();
  if (!sourceDocs.length && !notes) return;
  if (srcTotalBytes() > SRC_MAX_TOTAL) { alert('Those documents add up to more than 20 MB — remove one or two and try again.'); return; }
  const btn = $('introBtn');
  btn.disabled = true;
  $('srcState').textContent = sourceDocs.length
    ? 'Reading the documents… (about 20–40 seconds)'
    : 'Working from your notes… (about 15–30 seconds)';
  try {
    const r = await api(API + '/intro', {
      method: 'POST',
      body: JSON.stringify({
        docs: sourceDocs.map((d) => ({ name: d.name, mediaType: d.mediaType, dataBase64: d.dataBase64 })),
        notes,
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
    $('srcState').textContent = 'Couldn\'t draft it (' + e.message + '). ' + (sourceDocs.length ? 'Try a clearer photo or a PDF.' : 'Try adding a little more detail.');
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
/* Pages the writer never wants offered. The backend already drops Cognito
   Forms pages and obvious junk; this covers the staff-only stragglers. */
function hiddenLinks() {
  try { return new Set(JSON.parse(localStorage.getItem('cuHiddenLinks') || '[]')); }
  catch { return new Set(); }
}
function hideLink(url) {
  const set = hiddenLinks();
  set.add(url);
  localStorage.setItem('cuHiddenLinks', JSON.stringify([...set]));
}

let linkSearchTimer = null;
let linkSearchHits = null;      // results from the site itself, when searching

/* The cached list only holds recent posts, and the site has hundreds. Anything
   typed here also asks WordPress directly so older posts can be found. */
function searchSiteForLinks(q) {
  clearTimeout(linkSearchTimer);
  if (q.length < 2) { linkSearchHits = null; renderLinkResults(); return; }
  linkSearchTimer = setTimeout(async () => {
    try {
      const r = await api(API + '/search?q=' + encodeURIComponent(q));
      linkSearchHits = r.results || [];
    } catch {
      linkSearchHits = null;    // fall back to the cached list
    }
    renderLinkResults();
  }, 350);
}

function renderLinkResults() {
  const q = $('linkSearch').value.trim().toLowerCase();
  const box = $('linkResults');
  box.innerHTML = '';
  const hidden = hiddenLinks();
  const all = [...siteData.pages, ...siteData.posts].filter((p) => !hidden.has(p.url));
  const local = q ? all.filter((p) => decode(p.title || '').toLowerCase().includes(q)) : null;
  // Merge what the site returned with what we already had, no repeats.
  const seen = new Set();
  const hits = (q
    ? [...local, ...(linkSearchHits || []).filter((p) => !hidden.has(p.url))]
        .filter((p) => (seen.has(p.url) ? false : seen.add(p.url)))
    : [...all].sort((a, b) => linkRank(a.title) - linkRank(b.title))
  ).slice(0, 14);
  hits.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'linkitem';
    d.innerHTML = `<span class="t">${esc(decode(p.title))}</span>` +
      `<button class="hidelink" title="Never suggest this page again">✕</button>` +
      `<button title="Add">＋</button>`;
    d.querySelector('.hidelink').onclick = (e) => {
      e.stopPropagation();
      hideLink(p.url);
      renderLinkResults();
    };
    d.querySelectorAll('button')[1].onclick = () => {
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
  const again = !!state.publishedId;
  btn.textContent = mode === 'future' ? (again ? 'Update the schedule' : 'Schedule this post')
    : mode === 'past' ? (again ? 'Update with that date' : 'Publish with that date')
    : (again ? 'Check & update the live post' : 'Check & publish');
  btn.title = again
    ? 'This draft already made a post on the site — publishing again updates that post in place.' : '';
}

/* ---------------------------------------------------------------- publish */
/* One checklist instead of a chain of pop-ups: the things that MUST be right
   block the button; the nice-to-haves each get a one-click fix. */
function checklistRows() {
  const f = progressFacts();
  const mode = state.when || 'now';
  const now = siteNow();
  const rows = [];
  rows.push({ must: true, ok: f.title, label: 'A title', fix: 'Add one', go: () => $('fTitle').focus() });
  rows.push({ must: true, ok: f.placed > 0, label: f.placed ? `${f.placed} photo${f.placed === 1 ? '' : 's'} in the post` : 'Photos in the post',
    fix: 'Lay them out', go: () => $('stepLayout').scrollIntoView({ behavior: 'smooth' }) });
  if (f.lonely) rows.push({ must: true, ok: false, label: `${f.lonely} vertical photo${f.lonely === 1 ? '' : 's'} standing alone`,
    fix: 'Pair them up', act: () => { fixLoneVerticals(); } });
  if (mode !== 'now') {
    const bad = !state.whenAt || (mode === 'future' && state.whenAt <= now) || (mode === 'past' && state.whenAt > now);
    rows.push({ must: true, ok: !bad, label: mode === 'future' ? 'A valid time to go live' : 'A valid past date',
      fix: 'Fix the date', go: () => $('fWhen').focus() });
  }
  rows.push({ must: false, ok: f.unused === 0, label: f.unused ? `${f.unused} photo${f.unused === 1 ? '' : 's'} left out of the post` : 'Every photo is in the post',
    fix: 'Add them at the end', act: () => {
      const used = usedPids();
      const free = sortByTaken(state.photoOrder.filter((p) => !used.has(p)));
      chunkRows(free).forEach((r) => state.blocks.push({ type: 'row', slots: r }));
      fixLoneVerticals(); renderBlocks(); renderTray(); touch();
    } });
  rows.push({ must: false, ok: f.words > 0, label: f.words ? `${f.words} paragraph${f.words === 1 ? '' : 's'} of words` : 'No words in the post',
    fix: 'Paste the write-up', go: () => $('pasteWordsBtn').click() });
  rows.push({ must: false, ok: f.noAlt === 0, label: f.noAlt ? `${f.noAlt} photo${f.noAlt === 1 ? '' : 's'} without alt text (Google reads it)` : 'Alt text on every photo',
    fix: '✨ Write them now', act: async () => { await writeAllAlts(true); } });
  rows.push({ must: false, ok: f.meta, label: f.meta ? 'Meta description' : 'No meta description (what Google shows)',
    fix: 'Write it', go: () => $('fMetaDesc').focus() });
  rows.push({ must: false, ok: f.cats > 0, label: f.cats ? `${f.cats} categor${f.cats === 1 ? 'y' : 'ies'}` : 'No category chosen',
    fix: 'Choose', go: () => $('catChips').scrollIntoView({ behavior: 'smooth', block: 'center' }) });
  return rows;
}

function renderChecklist() {
  const rows = checklistRows();
  const box = $('checkList');
  box.innerHTML = '';
  rows.forEach((r) => {
    const d = document.createElement('div');
    d.className = 'check ' + (r.ok ? 'ok' : (r.must ? 'must' : 'warn'));
    d.innerHTML = `<span class="mark">${r.ok ? '✓' : (r.must ? '!' : '○')}</span>
      <span class="lbl">${esc(r.label)}${!r.ok && !r.must ? ' <em>optional</em>' : ''}</span>`;
    if (!r.ok) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = r.fix;
      b.onclick = async () => {
        if (r.act) { b.disabled = true; b.textContent = 'Working…'; await r.act(); renderChecklist(); }
        else { $('publishCheck').classList.add('hidden'); r.go(); }
      };
      d.appendChild(b);
    }
    box.appendChild(d);
  });
  const blocked = rows.some((r) => r.must && !r.ok);
  const warns = rows.filter((r) => !r.must && !r.ok).length;
  const go = $('checkGo');
  go.disabled = blocked;
  const mode = state.when || 'now';
  const again = !!state.publishedId;
  go.textContent = mode === 'future' ? (again ? 'Update the schedule' : 'Schedule it')
    : mode === 'past' ? (again ? 'Update with that date' : 'Publish with that date')
    : (again ? 'Update it now' : 'Publish it now');
  const h3 = document.querySelector('#publishCheck h3');
  if (h3) h3.textContent = again ? 'Update the live post?' : 'Ready to publish?';
  $('checkSummary').textContent = blocked
    ? 'Fix the items marked ! first.'
    : warns ? `Everything required is done. ${warns} optional thing${warns === 1 ? '' : 's'} could still be better.`
    : 'Everything looks good.';
}

function publish() {
  renderChecklist();
  $('publishCheck').classList.remove('hidden');
}

async function doPublish() {
  $('publishCheck').classList.add('hidden');
  const used = usedPids();
  const pids = state.photoOrder.filter((p) => used.has(p));
  const mode = state.when || 'now';
  if (!pids.length || !state.title.trim()) return;
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
        // Re-publishing a post this draft already made updates it in place
        // instead of creating a second one.
        postId: state.publishedId || 0,
      }),
    });
    state.publishedUrl = r.link;
    state.publishedId = r.id || 0;
    const scheduled = r.status === 'future';
    setBar(1, scheduled ? 'Scheduled!' : 'Done!');
    $('pubDoneTitle').textContent = scheduled
      ? `Scheduled for ${prettyWhen(state.whenAt)} 🗓`
      : r.updated ? 'Updated the live post ✅' : "It's live! 🎉";
    $('pubDoneNote').textContent = scheduled
      ? 'WordPress will put it on the blog automatically at that time — nothing else to do.'
      : r.updated ? 'Same post, same address — the old version is gone. Browsers and the site cache can hold on to the previous one for a few minutes.'
      : (mode === 'past' ? `Published and dated ${prettyWhen(state.whenAt)}.` : '');
    $('pubLink').textContent = r.link;
    $('pubLink').href = r.link;
    $('pubDone').classList.remove('hidden');
    renderWhen();
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

/* Drafts published before the app remembered post ids carry the post's URL but
   no id, so re-publishing one would make a second post instead of updating the
   first. Ask WordPress which post owns that address — the public REST API, no
   login needed for a live post. Best effort: if it can't be resolved the button
   simply keeps saying "Publish", which is what it said before. */
async function backfillPublishedId() {
  if (!state.publishedUrl || state.publishedId) return;
  const slug = state.publishedUrl.replace(/\/+$/, '').split('/').pop();
  if (!slug) return;
  const draft = state;   // guard: the person may open another draft meanwhile
  try {
    const r = await fetch(`${SITE}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=id,link`);
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) return;
    const hit = list.find((p) => p.link === draft.publishedUrl) || list[0];
    if (hit && hit.id && state === draft) {
      state.publishedId = hit.id;
      renderWhen(); touch();
    }
  } catch { /* offline, or the site's REST API is closed to the browser: leave it */ }
}

function loadState(s) {
  // Older saved drafts predate these fields.
  s.inlineLinks = s.inlineLinks || [];
  s.credit = s.credit || '';
  s.sourceFacts = s.sourceFacts || null;
  s.when = s.when || 'now';
  s.whenAt = s.whenAt || '';
  s.secondaryKeywords = s.secondaryKeywords || [];
  s.publishedId = s.publishedId || 0;
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
  renderWhen(); renderOutline(); resetUndo(); renderProgress();
  backfillPublishedId();
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
  wireCullZoom();
  $('fileInput').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));

  document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addBlock(b.dataset.add));
  $('pasteWordsBtn').onclick = () => { $('wordsInput').value = ''; $('wordsModal').classList.remove('hidden'); $('wordsInput').focus(); };
  $('wordsGoBtn').onclick = () => { addWords($('wordsInput').value); $('wordsModal').classList.add('hidden'); };
  $('magicLayoutBtn').onclick = magicLayout;
  $('undoBtn').onclick = undoLayout;
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || (e.key || '').toLowerCase() !== 'z') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('.overlay:not(.hidden)')) return;
    e.preventDefault();
    undoLayout();
  });
  // Dropping a photo below the last block (or into an empty layout) appends a row.
  const blocksBox = $('blocks');
  blocksBox.addEventListener('dragover', (e) => {
    if (!dragPid) return;
    if (e.target.closest('.block')) { blocksBox.classList.remove('photo-drop-end'); return; }
    e.preventDefault();
    blocksBox.classList.add('photo-drop-end');
  });
  blocksBox.addEventListener('dragleave', () => blocksBox.classList.remove('photo-drop-end'));
  blocksBox.addEventListener('drop', (e) => {
    if (!dragPid || e.target.closest('.block')) return;
    e.preventDefault();
    dropPhotoAsNewRow(state.blocks.length, false);
  });
  document.querySelectorAll('#progress .pstep').forEach((st) => {
    st.onclick = () => { const t = $(st.dataset.step); if (t) t.scrollIntoView({ behavior: 'smooth' }); };
  });
  if (localStorage.getItem('cuHowtoSeen')) $('howto').classList.add('hidden');
  $('howtoClose').onclick = () => { $('howto').classList.add('hidden'); localStorage.setItem('cuHowtoSeen', '1'); };
  $('checkGo').onclick = doPublish;
  $('checkClose').onclick = () => $('publishCheck').classList.add('hidden');
  $('publishCheck').onclick = (e) => { if (e.target === $('publishCheck')) $('publishCheck').classList.add('hidden'); };

  $('aiBtn').onclick = aiSuggest;

  // source material → opening paragraph
  const sd = $('srcDrop');
  $('srcBrowseBtn').onclick = () => $('srcInput').click();
  $('srcInput').onchange = (e) => { addSourceFiles(e.target.files); e.target.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => sd.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); sd.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => sd.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); sd.classList.remove('drag'); }));
  sd.addEventListener('drop', (e) => addSourceFiles(e.dataTransfer.files));
  $('srcNotes').oninput = renderSourceDocs;   // keep the draft button in step with typed notes
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
  $('linkSearch').oninput = () => { renderLinkResults(); searchSiteForLinks($('linkSearch').value.trim()); };
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
  $('pmFeatureBtn').onclick = () => { state.featuredPid = modalPid; state.featuredChosen = true; renderTray(); touch(); };
  $('selRowBtn').onclick = () => commitSel('row');
  $('selEachBtn').onclick = () => commitSel('each');
  $('selCancelBtn').onclick = clearSel;
  $('pmDipBtn').onclick = () => startRowFrom(modalPid, 2);
  $('pmTripBtn').onclick = () => startRowFrom(modalPid, 3);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !(sel.pids.length || sel.target)) return;
    if (document.querySelector('.overlay:not(.hidden)')) return;      // a modal owns Esc
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName)) return;
    clearSel();
  });
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
    forgetOriginal(modalPid);
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
