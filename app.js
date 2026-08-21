/* Christian Unified Blog Builder — builds a real photo blog post and publishes
   it to christianunified.org. Same app as the Amy Gray Photography builder,
   pointed at the school: one passphrase, then drag in photos, paste the words,
   press ✨ for SEO, press Publish. No accounts, no installs. */
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

/* Keywords the school wants to rank for. Editable in the app; kept in this
   browser and shared across every post you write on this computer. */
const DEFAULT_KEYWORDS = [
  'Christian school San Diego', 'private school El Cajon',
  'Christian high school San Diego', 'Christian school Chula Vista',
  'private Christian school San Diego', 'Christian elementary school El Cajon',
  'Christian junior high San Diego', 'private schools near me San Diego',
  'Christian education San Diego', 'Christian Unified Schools',
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
    metaDesc: '', focusKeyword: '', excerpt: '', secondaryKeywords: [],
    photos: {}, photoOrder: [],
    blocks: [],
    links: { internal: [], external: [] },
    inlineLinks: [],
    featuredPid: null,
    publishedUrl: '',
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
      (used.has(pid) ? '<span class="flag">in post</span>' : '');
    d.onclick = () => openPhotoModal(pid);
    tray.appendChild(d);
  });
}

let modalPid = null;
function openPhotoModal(pid) {
  modalPid = pid;
  const p = state.photos[pid];
  $('pmImg').src = p.thumb;
  $('pmAlt').value = p.alt;
  $('pmFilename').value = p.filename;
  $('pmCaption').value = p.caption || '';
  $('photoModal').classList.remove('hidden');
}

/* ----------------------------------------------------------------- blocks */
function addBlock(kind, at) {
  const b = kind === 'text' ? { type: 'text', text: '' }
    : kind === 'heading' ? { type: 'heading', text: '' }
    : { type: 'row', slots: new Array(kind === 'row1' ? 1 : kind === 'row2' ? 2 : 3).fill(null) };
  if (at == null) state.blocks.push(b); else state.blocks.splice(at, 0, b);
  renderBlocks(); touch();
}

function renderBlocks() {
  const box = $('blocks');
  box.innerHTML = '';
  if (!state.blocks.length) {
    box.innerHTML = '<p class="hint">Nothing here yet — add a photo row or paste the write-up to begin.</p>';
  }
  state.blocks.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'block';
    const tools = `<div class="tools">
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
      row.className = 'photo-row';
      b.slots.forEach((pid, si) => {
        const slot = document.createElement('div');
        slot.className = 'slot';
        const p = pid && state.photos[pid];
        if (p) {
          slot.style.flex = `${(p.w / p.h).toFixed(3)} 1 0%`;
          slot.style.aspectRatio = `${p.w} / ${p.h}`;
          slot.innerHTML = `<img src="${p.thumb}" alt="">
            <div class="slot-hover">
              <button data-s="swap">Swap</button>
              <button data-s="clear">Remove</button>
            </div>`;
          slot.querySelector('[data-s=swap]').onclick = (e) => { e.stopPropagation(); openPicker(b, si); };
          slot.querySelector('[data-s=clear]').onclick = (e) => {
            e.stopPropagation(); b.slots[si] = null; renderBlocks(); renderTray(); touch();
          };
        } else {
          slot.textContent = '+ photo';
          slot.onclick = () => openPicker(b, si);
        }
        row.appendChild(slot);
      });
      d.innerHTML = tools;
      d.appendChild(row);
    }
    d.querySelectorAll('.tools button').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'del') state.blocks.splice(i, 1);
        if (act === 'up' && i > 0) [state.blocks[i - 1], state.blocks[i]] = [state.blocks[i], state.blocks[i - 1]];
        if (act === 'down' && i < state.blocks.length - 1) [state.blocks[i + 1], state.blocks[i]] = [state.blocks[i], state.blocks[i + 1]];
        renderBlocks(); renderTray(); touch();
      };
    });
    box.appendChild(d);
  });
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
    d.className = 'thumb' + (used.has(pid) ? ' used' : '');
    d.innerHTML = `<img src="${p.thumb}" alt="">` + (used.has(pid) ? '<span class="flag">in post</span>' : '');
    d.onclick = () => {
      pickTarget.block.slots[pickTarget.slotIndex] = pid;
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

function magicLayout() {
  const used = usedPids();
  const free = state.photoOrder.filter((pid) => !used.has(pid));
  if (!free.length) return;
  const pattern = [1, 2, 3, 2, 1, 3, 2, 2];
  let pi = 0;
  while (free.length) {
    let n = Math.min(pattern[pi % pattern.length], free.length);
    // avoid a lonely leftover after a big row
    if (free.length - n === 1 && n > 1) n -= 1;
    state.blocks.push({ type: 'row', slots: free.splice(0, n) });
    pi += 1;
  }
  renderBlocks(); renderTray(); touch();
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
   absence reports. Those are never worth linking from a blog post, so when the
   search box is empty show the public-facing pages first instead of whatever
   WordPress happens to return first. */
const FORMY = /sign-?in|permission|absence|rsvp|survey|payment|requisition|registration|observation|agreement|concern|interview|handbook|request|directory|fees|budget|assessment|reimburse|payroll|substitute|thank you|received|sign-?up|\bform\b/i;
/* Word boundaries matter here: without \b, "Parental Permission" matches
   "mission" and a permission slip outranks the Missions program page. */
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
    // A few thumbnails give the model a feel for the session; alt text for every
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
   priority order — a district-wide "Schedule a Tour" beats one campus's page. */
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
    `<p style="margin-top:30px;">Want to see this for your own family? ` +
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
    <link href="https://fonts.googleapis.com/css2?family=Mulish:wght@300;400&family=Raleway:wght@600;700&display=swap" rel="stylesheet">
    <style>
      body{font-family:Mulish,sans-serif;font-weight:300;color:#2c3440;max-width:860px;margin:0 auto;padding:30px 20px;line-height:1.7;}
      h1,h2{font-family:Raleway,sans-serif;font-weight:700;color:#00244c;}
      h1{font-size:2rem;} a{color:#0a5aa8;}
      img{max-width:100%;}
    </style></head><body>
    <h1>${esc(state.title || 'Untitled post')}</h1>
    ${html}</body></html>`;
  $('previewModal').classList.remove('hidden');
}

/* ---------------------------------------------------------------- publish */
async function publish() {
  const used = usedPids();
  const pids = state.photoOrder.filter((p) => used.has(p));
  if (!state.title.trim()) { alert('Give the post a title first (step 1).'); return; }
  if (!pids.length) { alert('The post has no photos yet — drop some into rows in step 3.'); return; }
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
        status: 'publish',
      }),
    });
    state.publishedUrl = r.link;
    setBar(1, 'Done!');
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
  s.secondaryKeywords = s.secondaryKeywords || [];
  s.credit = s.credit || '';
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
  $('fileInput').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));

  document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addBlock(b.dataset.add));
  $('pasteWordsBtn').onclick = () => { $('wordsInput').value = ''; $('wordsModal').classList.remove('hidden'); $('wordsInput').focus(); };
  $('wordsGoBtn').onclick = () => { addWords($('wordsInput').value); $('wordsModal').classList.add('hidden'); };
  $('magicLayoutBtn').onclick = magicLayout;

  $('aiBtn').onclick = aiSuggest;
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

  $('previewBtn').onclick = showPreview;
  $('publishBtn').onclick = publish;
  $('exportBtn').onclick = exportDesign;
  $('importBtn').onclick = () => $('importInput').click();
  $('importInput').onchange = (e) => { if (e.target.files[0]) importDesign(e.target.files[0]); e.target.value = ''; };

  document.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => $(b.dataset.close).classList.add('hidden'));
}

init();
