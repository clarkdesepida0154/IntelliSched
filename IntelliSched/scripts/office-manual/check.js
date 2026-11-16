#!/usr/bin/env node
// Phase 15: the Office Manual's checks.
//   node scripts/office-manual/check.js
// 1. Every **bold** name in the manual (a button, menu, page or field as the screen shows it) is looked up
//    in the app's client source (client/src), its gateway messages (server/src), the office kit's files
//    (deploy/) or, for the Windows steps, a short list of Windows' own words. A label the screen shows in
//    capitals through CSS matches its source ignoring case. "v1" in a name stands for any version.
// 2. Every picture in docs/office-manual/images/ was taken by shoot.js and passed its blur check (the log
//    .demo-data/logs/office-manual-shots.json records each one with its blurred items), and every picture
//    the text uses exists.
// Writes .demo-data/logs/office-manual-check.json; exit 1 on any mismatch.
const fs = require('fs');
const path = require('path');
const { readContent, inlineRuns } = require('./parse');

const REPO = path.resolve(__dirname, '..', '..');
const LOG = path.join(REPO, '.demo-data', 'logs', 'office-manual-check.json');
const WINDOWS = ['Start', 'File Explorer', 'Documents', 'Copy', 'Paste', 'Eject', 'Run as administrator', 'Windows PowerShell', 'Adjust date and time', 'Google Drive for desktop', 'Google Drive', 'My Drive', 'Downloads', 'IntelliSched Backups', 'IntelliSched-backup_', '.isbak', '.zip'];

const norm = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const corpusOf = (dir, exts) => {
  const parts = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'tests'].includes(e.name)) walk(p); } else if (exts.some(x => e.name.endsWith(x))) parts.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return norm(parts.join('\n'));
};
const corpora = [
  ['client', corpusOf(path.join(REPO, 'client', 'src'), ['.js', '.jsx'])],
  ['server', corpusOf(path.join(REPO, 'server', 'src'), ['.js'])],
  ['kit', corpusOf(path.join(REPO, 'deploy'), ['.txt', '.md', '.ps1', '.bat', '.js'])]
];

const result = { at: new Date().toISOString(), names: [], pictures: {} };
const chapters = readContent();
const seen = new Map();
const collect = (text, where) => { for (const r of inlineRuns(text)) if (r.ui) { const k = norm(r.text); if (!seen.has(k)) seen.set(k, where); } };
const walkBlocks = (blocks, where) => {
  for (const b of blocks) {
    if (b.text) collect(b.text, where);
    if (b.alt) collect(b.alt, where);
    if (b.items) for (const it of b.items) { collect(typeof it === 'string' ? it : it.text, where); if (typeof it !== "string") it.sub.forEach(s => collect(s, where)); }
    if (b.rows) b.rows.flat().forEach(c => collect(c, where));
    if (b.blocks) { collect(b.title, where); walkBlocks(b.blocks, where); }
  }
};
for (const c of chapters) { collect(c.title, c.title); collect(c.intro, c.title); walkBlocks(c.blocks, c.title); }

const inCorpus = (s) => corpora.some(([, text]) => text.includes(s));
for (const [name, where] of seen) {
  let how = null;
  // "Group → Page": each part is a menu name of its own.
  if (name.includes(' → ')) {
    const parts = name.split(' → ').map(s => s.trim());
    result.names.push({ name, chapter: where, how: parts.every(inCorpus) ? 'menu path (each part)' : 'NOT FOUND' });
    continue;
  }
  // A button the page builds from a word and a name: "Open <page>", "Download <format>".
  const built = /^(Open|Download) (.+)$/.exec(name);
  if (built && inCorpus(built[2]) && inCorpus(`${built[1]} `)) { result.names.push({ name, chapter: where, how: `"${built[1]} " + a name` }); continue; }
  // A label with a number in it ("After 30 minutes"): the fixed words around the number.
  if (/\d/.test(name) && !inCorpus(name)) {
    const parts = name.split(/\d+/).map(s => s.trim()).filter(s => s.length >= 3);
    if (parts.length && parts.every(inCorpus)) { result.names.push({ name, chapter: where, how: 'with a number' }); continue; }
  }
  const found = corpora.find(([, text]) => text.includes(name));
  if (found) how = found[0];
  else if (corpora.some(([, text]) => text.toLowerCase().includes(name.toLowerCase()))) how = 'case (CSS capitals)';
  else if (/\bv1\b/.test(name)) {
    const parts = name.split(/\bv1\b/).map(s => s.trim()).filter(Boolean);
    if (parts.every(p => corpora.some(([, text]) => text.includes(p)))) how = 'with the version name';
  }
  if (!how && WINDOWS.includes(name)) how = 'Windows / the kit / the manual\'s own word';
  result.names.push({ name, chapter: where, how: how || 'NOT FOUND' });
}

// The pictures.
const IMG = path.join(REPO, 'docs', 'office-manual', 'images');
const shots = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'logs', 'office-manual-shots.json'), 'utf8')).shots; } catch { return {}; } })();
const files = fs.existsSync(IMG) ? fs.readdirSync(IMG).filter(f => f.endsWith('.jpg')) : [];
const used = new Set();
for (const c of chapters) {
  const visit = (blocks) => { for (const b of blocks) { if (b.type === 'img') used.add(path.basename(b.src)); if (b.type === 'word' && b.img) used.add(path.basename(b.img)); if (b.blocks) visit(b.blocks); } };
  visit(c.blocks);
}
for (const f of files) {
  const s = shots[f.replace(/\.jpg$/, '')];
  result.pictures[f] = { scanned: Boolean(s), blurred: s ? s.blurred : null, kinds: s ? s.blurredKinds : null, used: used.has(f) };
}
const missingPictures = [...used].filter(f => !files.includes(f));
const notScanned = Object.entries(result.pictures).filter(([, v]) => !v.scanned).map(([k]) => k);
const unused = Object.entries(result.pictures).filter(([, v]) => !v.used).map(([k]) => k);
const bad = result.names.filter(n => n.how === 'NOT FOUND');
result.summary = {
  boldNames: result.names.length,
  byHow: result.names.reduce((a, n) => ({ ...a, [n.how]: (a[n.how] || 0) + 1 }), {}),
  notFound: bad.map(n => `${n.name}  (${n.chapter})`),
  pictures: files.length, picturesUsed: used.size, missingPictures, notScanned, unused,
  blurredItems: Object.values(result.pictures).reduce((a, v) => a + (v.blurred || 0), 0),
  imagesMB: Number((files.reduce((a, f) => a + fs.statSync(path.join(IMG, f)).size, 0) / 1048576).toFixed(1))
};
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary, null, 2));
process.exitCode = bad.length || missingPictures.length || notScanned.length ? 1 : 0;
