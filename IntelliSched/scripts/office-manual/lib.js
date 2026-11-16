// Phase 15: the shared pieces of the Office Manual's screenshot script (shoot.js).
// - The practice copy only: .demo-data/run.json must name a ready `npm run demo:sem2:reset -- --faculty-seed`
//   on a _test database (never the defense database, never intellisched_db, never C:\IntelliSched).
// - Markers: an SVG overlay drawn from each target's real bounding box (numbered circles in the app's blue,
//   a rounded highlight box, an optional arrow), removed after the shot.
// - Blurring: every real person's name (the faculty, the signatories, accounts not named PRACTICE/TEST) and
//   every e-mail address gets a blur patch (CSS backdrop-filter) over the exact text rectangles; an input
//   holding a name is covered whole. A second, independent scan then checks every occurrence of every name
//   inside the picture is covered, or the shot fails.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'docs', 'office-manual', 'images');
const STATE_FILE = path.join(REPO, '.demo-data', 'office-manual-state.json');
const LOG_FILE = path.join(REPO, '.demo-data', 'logs', 'office-manual-shots.json');
const BLUE = '#2563EB';

const readRun = () => {
  const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
  if (run.state !== 'ready' || run.mode !== 'sem2') throw new Error('Needs a ready `npm run demo:sem2:reset -- --faculty-seed` (the practice copy).');
  const db = run.database || '';
  if (/defense|^intellisched_db$/.test(db) || !/_test$/.test(db)) throw new Error(`Refusing database ${db}.`);
  if (run.facultySource && run.facultySource !== 'seed') throw new Error('Start the practice copy with -- --faculty-seed (tracked data only).');
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  return {
    run, secrets,
    client: run.clientUrl || `http://localhost:${run.ports.client}`,
    api: `${run.gatewayUrl || `http://localhost:${run.ports.gateway}`}/api`,
    mongoUri: `mongodb://127.0.0.1:${run.ports.mongo}/${db}`
  };
};

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

const apiCall = async (ctx, method, route, token, body) => {
  const res = await fetch(`${ctx.api}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
};
const login = async (ctx, email, password) => {
  const r = await apiCall(ctx, 'POST', '/auth/login', null, { username: email, password });
  return r.ok ? r.json.token : null;
};

// Every real person's name the practice copy holds, as the strings to blur (longest first).
const loadNames = async (ctx, token) => {
  const names = new Set();
  const addPerson = (full) => {
    if (!full || /^(PRACTICE|TEST)\b/i.test(full.trim()) || /\(demo only\)|UI check/i.test(full)) return;
    const clean = full.replace(/\s+/g, ' ').trim();
    names.add(clean);
    const noSuffix = clean.replace(/,?\s+(Jr\.?|Sr\.?|III|II|IV)$/i, '').replace(/,\s*(PhD|EdD|MIT|MSIT|MS|DIT|MA|MBA|Ph\.D\.)\b.*$/i, '').replace(/^(ATTY\.|DR\.|ENGR\.)\s+/i, '');
    names.add(noSuffix);
    const parts = noSuffix.split(' ').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.replace(/\W/g, '').length >= 3) names.add(last);
    // First names (one or two words before the middle initial).
    const firstParts = [];
    for (const p of parts.slice(0, -1)) { if (/^[A-Z]\.$/i.test(p)) break; firstParts.push(p); }
    if (firstParts.length) {
      const first = firstParts.join(' ');
      if (first.length >= 4) names.add(first);
      for (const f of firstParts) if (f.length >= 4) names.add(f);
    }
  };
  const fac = await apiCall(ctx, 'GET', '/faculty', token);
  for (const f of (Array.isArray(fac.json) ? fac.json : fac.json.data || [])) addPerson(f.name);
  const users = await apiCall(ctx, 'GET', '/users', token);
  for (const u of (users.json.users || users.json.data || (Array.isArray(users.json) ? users.json : []))) addPerson(u.name);
  const outside = await apiCall(ctx, 'GET', '/outside-teachers', token);
  for (const t of (Array.isArray(outside.json) ? outside.json : outside.json.data || [])) addPerson(t.name);
  const os = await apiCall(ctx, 'GET', '/output-settings', token);
  for (const key of ['teachersProgram', 'motherSchedule', 'roomProgram', 'roomSchedule', 'classSchedule']) {
    for (const s of (os.json?.[key]?.signatories || [])) addPerson(s.name);
  }
  return [...names].filter(n => n.length >= 3).sort((a, b) => b.length - a.length);
};

// ---------------------------------------------------------------------------------------- in the page
// Draws the blur patches and the markers; returns what it blurred. Runs in the browser.
function drawOverlay({ names, marks, color, clip }) {
  document.getElementById('om-overlay')?.remove();
  const root = document.createElement('div');
  root.id = 'om-overlay';
  root.setAttribute('aria-hidden', 'true');
  Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = names.length ? new RegExp(`(?<![A-Za-z])(${names.map(esc).join('|')})(?![A-Za-z])`, 'gi') : null;
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const ratingRe = /(Student evaluation:\s*\d+(\.\d+)?\s*of 5|\b[1-5]\.\d{2}\s*of 5\b)/g;
  const inClip = (r) => !clip || (r.right > clip.x && r.left < clip.x + clip.width && r.bottom > clip.y && r.top < clip.y + clip.height);
  const shown = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
      if (s.position === 'absolute' && s.clip && s.clip !== 'auto') return false;
      if (e.getAttribute('aria-hidden') === 'true' && e.tagName === 'SELECT') return false;
    }
    return true;
  };
  const occluded = (el, r) => [r.left + 2, r.left + r.width / 2, r.right - 2].every((x) => { const t = document.elementFromPoint(x, r.top + r.height / 2); return Boolean(t) && !el.contains(t) && !t.contains(el); });
  const rects = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue;
    if (!text || !text.trim() || !n.parentElement || n.parentElement.closest('#om-overlay, option, script, style')) continue;
    for (const re of [nameRe, emailRe, ratingRe].filter(Boolean)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const range = document.createRange();
        range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
        for (const r of range.getClientRects()) if (r.width > 2 && r.height > 4 && inClip(r) && shown(n.parentElement) && !occluded(n.parentElement, r)) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height, what: m[0] });
      }
    }
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    const v = el.value || '';
    if (!v || el.type === 'password' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'hidden' || el.type === 'file') continue;
    const hitName = nameRe && (nameRe.lastIndex = 0, nameRe.test(v));
    emailRe.lastIndex = 0;
    if (hitName || emailRe.test(v)) {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 4 && inClip(r) && shown(el) && !occluded(el, r)) rects.push({ x: r.left + 4, y: r.top + 3, w: r.width - 8, h: r.height - 6, what: v });
    }
  }
  for (const r of rects) {
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'fixed', left: `${r.x - 3}px`, top: `${r.y - 2}px`, width: `${r.w + 6}px`, height: `${r.h + 4}px`, backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)', background: 'rgba(148,163,184,0.18)', borderRadius: '4px' });
    root.appendChild(d);
  }
  // The markers.
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(innerWidth)); svg.setAttribute('height', String(innerHeight));
  Object.assign(svg.style, { position: 'fixed', left: '0', top: '0', overflow: 'visible' });
  svg.innerHTML = `<defs><marker id="om-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`;
  const add = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); svg.appendChild(e); return e; };
  const lim = clip || { x: 0, y: 0, width: innerWidth, height: innerHeight };
  const clampX = (x) => Math.max(lim.x + 15, Math.min(lim.x + lim.width - 15, x));
  const clampY = (y) => Math.max(lim.y + 15, Math.min(lim.y + lim.height - 15, y));
  for (const m of marks) {
    const b = m.box;
    if (!b) continue;
    const p = m.padBox ?? 4;
    if (m.highlight !== false) add('rect', { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p, rx: 8, fill: 'none', stroke: color, 'stroke-width': 3 });
    if (m.arrow) {
      const cx = b.x + b.width / 2; const cy = b.y + b.height / 2;
      const L = m.arrowLength || 70;
      const from = { left: [b.x - p - L, cy], right: [b.x + b.width + p + L, cy], up: [cx, b.y - p - L], down: [cx, b.y + b.height + p + L] }[m.arrow];
      const to = { left: [b.x - p - 4, cy], right: [b.x + b.width + p + 4, cy], up: [cx, b.y - p - 4], down: [cx, b.y + b.height + p + 4] }[m.arrow];
      add('line', { x1: from[0], y1: from[1], x2: to[0], y2: to[1], stroke: color, 'stroke-width': 4, 'stroke-linecap': 'round', 'marker-end': 'url(#om-ah)' });
    }
    if (m.n != null) {
      const at = m.at || 'tl';
      let x; let y;
      if (at === 'tl') { x = b.x - p; y = b.y - p; }
      else if (at === 'tr') { x = b.x + b.width + p; y = b.y - p; }
      else if (at === 'bl') { x = b.x - p; y = b.y + b.height + p; }
      else if (at === 'br') { x = b.x + b.width + p; y = b.y + b.height + p; }
      else if (at === 'l') { x = b.x - p - 16; y = b.y + b.height / 2; }
      else if (at === 'r') { x = b.x + b.width + p + 16; y = b.y + b.height / 2; }
      else if (at === 'c') { x = b.x + b.width / 2; y = b.y + b.height / 2; }
      x = clampX(x); y = clampY(y);
      add('circle', { cx: x, cy: y, r: 13, fill: color, stroke: '#fff', 'stroke-width': 2.5 });
      const t = add('text', { x, y: y + 5, 'text-anchor': 'middle', 'font-family': 'Segoe UI, Arial, sans-serif', 'font-size': 15, 'font-weight': 700, fill: '#fff' });
      t.textContent = String(m.n);
    }
  }
  root.appendChild(svg);
  document.body.appendChild(root);
  return rects.map(r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), kind: /@/.test(r.what) ? 'email' : (/of 5|evaluation/i.test(r.what) ? 'rating' : 'name') }));
}

// The independent check: every visible occurrence of a name, an e-mail or a rating inside the picture
// must lie under a blur patch. Returns the uncovered texts.
function verifyCovered({ names, clip }) {
  const patches = [...document.querySelectorAll('#om-overlay > div')].map(d => d.getBoundingClientRect());
  const lower = names.map(n => n.toLowerCase());
  const occluded = (el, r) => [r.left + 2, r.left + r.width / 2, r.right - 2].every((x) => { const t = document.elementFromPoint(x, r.top + r.height / 2); return Boolean(t) && !el.contains(t) && !t.contains(el); });

  const leaks = [];
  const covered = (r) => patches.some(p => r.left >= p.left - 1 && r.right <= p.right + 1 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1);
  const inClip = (r) => r.right > clip.x && r.left < clip.x + clip.width && r.bottom > clip.y && r.top < clip.y + clip.height;
  const isWordChar = (c) => /[A-Za-z]/.test(c || '');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue || '';
    const low = text.toLowerCase();
    if (!text.trim() || !n.parentElement || n.parentElement.closest('#om-overlay, option, script, style')) continue;
    const s = getComputedStyle(n.parentElement);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const hits = [];
    lower.forEach((name, i) => { let at = low.indexOf(name); while (at >= 0) { if (!isWordChar(low[at - 1]) && !isWordChar(low[at + name.length])) hits.push([at, names[i].length]); at = low.indexOf(name, at + 1); } });
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) hits.push([m.index, m[0].length]);
    for (const [at, len] of hits) {
      const range = document.createRange(); range.setStart(n, at); range.setEnd(n, at + len);
      for (const r of range.getClientRects()) {
        if (r.width <= 2 || r.height <= 4 || !inClip(r)) continue;
        // Text the browser does not paint (opacity 0 up the tree) is not in the picture.
        let hidden = false;
        for (let e = n.parentElement; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (Number(cs.opacity) < 0.05 || cs.display === 'none' || (cs.position === 'absolute' && cs.clip && cs.clip !== 'auto')) { hidden = true; break; } }
        if (!hidden && !occluded(n.parentElement, r) && !covered(r)) leaks.push(text.slice(at, at + len));
      }
    }
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    const v = (el.value || '').toLowerCase();
    if (!v || ['password', 'checkbox', 'radio', 'hidden', 'file'].includes(el.type)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || !inClip(r) || occluded(el, r)) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const named = lower.some(n => { let at = v.indexOf(n); while (at >= 0) { if (!isWordChar(v[at - 1]) && !isWordChar(v[at + n.length])) return true; at = v.indexOf(n, at + 1); } return false; });
    if (named || /@/.test(v)) {
      const inner = { left: r.left + 6, right: r.left + Math.min(r.width - 6, 40), top: r.top + 6, bottom: r.bottom - 6 };
      if (!covered(inner)) leaks.push(el.value);
    }
  }
  return leaks;
}

module.exports = { REPO, OUT_DIR, STATE_FILE, LOG_FILE, BLUE, readRun, readState, writeState, apiCall, login, loadNames, drawOverlay, verifyCovered };
