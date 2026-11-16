#!/usr/bin/env node
// Phase 15: builds the IntelliSched Office Manual from docs/office-manual/content/*.md and images/.
//   npm run office-manual:build        (repo root)
// Writes docs/office-manual/IntelliSched-Office-Manual-<version>.pdf (HTML + print CSS, printed by the
// installed Edge through Playwright, the way the app's tools drive it; with PDF bookmarks) and .docx (Word XML
// by hand, the gateway's ZIP writer; no new package), and docs/office-manual/source/office-manual.html (the
// HTML/CSS source, pictures linked as ../images/). The contents' page numbers come from the PDF's own
// bookmarks: the first print finds each heading's page, the second prints them (and is checked again).
// Then docs/office-manual/build-info.json (page count, pictures, SHA-256s).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readContent } = require('./parse');
const { buildHtml, number } = require('./html');
const { buildDocx } = require('./docx');

const REPO = path.resolve(__dirname, '..', '..');
const DIR = path.join(REPO, 'docs', 'office-manual');
const IMG = path.join(DIR, 'images');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8')).version;
const BASE = `IntelliSched-Office-Manual-${VERSION}`;
const PDF_FILE = path.join(DIR, `${BASE}.pdf`);
const DOCX_FILE = path.join(DIR, `${BASE}.docx`);
const SRC_FILE = path.join(DIR, 'source', 'office-manual.html');

// ---------------------------------------------------------------------------------------- PDF bookmarks
// Chromium writes plain (uncompressed-dictionary) objects: the page tree gives each page object its number,
// and each outline item names its page in /Dest [n 0 R …].
const pdfObjects = (buf) => {
  const text = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+) 0 obj\s*([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(text))) objs.set(Number(m[1]), m[2]);
  return objs;
};
const decodeTitle = (raw) => {
  if (raw.startsWith('<')) {
    const hex = raw.replace(/[<>\s]/g, '');
    const bytes = Buffer.from(hex, 'hex');
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) { let s = ''; for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i)); return s; }
    return bytes.toString('latin1');
  }
  return raw.slice(1, -1).replace(/\\([()\\])/g, '$1');
};
const outlinePages = (buf) => {
  const objs = pdfObjects(buf);
  const catalog = [...objs.values()].find(o => /\/Type\s*\/Catalog/.test(o));
  const pagesRoot = Number(/\/Pages\s+(\d+) 0 R/.exec(catalog)[1]);
  const order = [];
  const walk = (n) => {
    const o = objs.get(n);
    if (/\/Type\s*\/Pages/.test(o)) { const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o)[1]; for (const k of kids.matchAll(/(\d+) 0 R/g)) walk(Number(k[1])); }
    else order.push(n);
  };
  walk(pagesRoot);
  const pageOf = new Map(order.map((n, i) => [n, i + 1]));
  const outlines = /\/Outlines\s+(\d+) 0 R/.exec(catalog);
  const items = [];
  const visit = (n) => {
    for (let cur = n; cur; ) {
      const o = objs.get(cur);
      const title = /\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(o);
      const dest = /\/Dest\s*\[\s*(\d+) 0 R/.exec(o);
      items.push({ title: title ? decodeTitle(title[1]) : '', page: dest ? pageOf.get(Number(dest[1])) : null });
      const first = /\/First\s+(\d+) 0 R/.exec(o);
      if (first) visit(Number(first[1]));
      const next = /\/Next\s+(\d+) 0 R/.exec(o);
      cur = next ? Number(next[1]) : null;
    }
  };
  if (outlines) { const first = /\/First\s+(\d+) 0 R/.exec(objs.get(Number(outlines[1]))); if (first) visit(Number(first[1])); }
  return { items, pages: order.length };
};
// The table of contents' entries, matched in order to the bookmarks with the same title.
const pagesFor = (toc, items) => {
  const out = {};
  let at = 0;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const t of toc) {
    const i = items.findIndex((it, k) => k >= at && [norm(t.text), norm(t.text) + norm(t.text)].includes(norm(it.title)));
    if (i < 0) throw new Error(`No PDF bookmark for "${t.text}" (${items.length} bookmarks: ${JSON.stringify(items.slice(0, 6))}).`);
    out[t.id] = items[i].page;
    at = i + 1;
  }
  return out;
};

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');

(async () => {
  const meta = { version: VERSION, date: '16 November 2026', iso: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  const chapters = readContent();
  const pictures = chapters.flatMap(c => c.blocks.flatMap(b => (b.type === 'img' ? [b.src] : b.type === 'word' && b.img ? [b.img] : [])));
  const missing = pictures.filter(src => !fs.existsSync(path.join(IMG, path.basename(src))));
  if (missing.length) throw new Error(`Missing pictures: ${missing.join(', ')}`);

  const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const fileUrl = (name) => `file:///${path.join(IMG, name).replace(/\\/g, '/')}`;
  const print = async (html) => {
    const tmp = path.join(DIR, 'source', '.render.html');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, html);
    const page = await browser.newPage();
    await page.goto(`file:///${tmp.replace(/\\/g, '/')}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
    await page.close();
    fs.rmSync(tmp, { force: true });
    return pdf;
  };
  let pages = {};
  let pdf;
  let info;
  try {
    for (let pass = 1; pass <= 3; pass++) {
      const { html, toc } = buildHtml(readContent(), meta, fileUrl, pages);
      pdf = await print(html);
      info = outlinePages(pdf);
      const found = pagesFor(toc, info.items);
      const same = Object.keys(found).every(k => found[k] === pages[k]);
      console.log(`Pass ${pass}: ${info.pages} pages${same ? ', contents page numbers confirmed' : ''}.`);
      pages = found;
      if (same) break;
    }
  } finally { await browser.close(); }
  fs.writeFileSync(PDF_FILE, pdf);
  // The committed HTML source links the pictures relatively.
  fs.writeFileSync(SRC_FILE, buildHtml(readContent(), meta, (name) => `../images/${name}`, pages).html);

  // The Word file uses the same ids as the HTML (html.number), so the PDF's page numbers fill its contents.
  const numbered = number(readContent());
  const docx = buildDocx(numbered, meta, IMG, pages);
  fs.writeFileSync(DOCX_FILE, docx.zip);

  const sizeOf = (dir) => fs.readdirSync(dir).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  const result = {
    builtAt: new Date().toISOString(), version: VERSION, pdfPages: info.pages, picturesInText: pictures.length,
    picturesInDocx: docx.pictures, imagesFolderMB: Number((sizeOf(IMG) / 1048576).toFixed(1)),
    files: Object.fromEntries([PDF_FILE, DOCX_FILE, SRC_FILE].map(f => [rel(f), { kb: Math.round(fs.statSync(f).size / 1024), sha256: sha(f) }]))
  };
  fs.writeFileSync(path.join(DIR, 'build-info.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
