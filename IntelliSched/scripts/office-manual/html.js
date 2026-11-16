// Phase 15: the Office Manual as one HTML file with print CSS (A4 portrait, 20 mm margins, a running header
// with the chapter's name on the right, the page number and the version in the footer).
const path = require('path');
const { inlineRuns, plain } = require('./parse');

const BLUE = '#2563EB';
const NAVY = '#1E3A8A';
const GREY = '#64748B';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (text) => inlineRuns(text).map(r => {
  const t = esc(r.text);
  if (r.code) return `<code>${t}</code>`;
  if (r.ui) return `<b class="ui">${t}</b>`;
  return r.bold ? `<b>${t}</b>` : t;
}).join('');
const slug = (s) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ICON = { tip: '💡', careful: '⚠️', check: '✅' };
const WORD = { tip: 'Tip', careful: 'Careful', check: 'Check' };

const block = (b, imgDir) => {
  switch (b.type) {
    case 'h': return `<h${b.level} id="${b.id}">${inline(b.text)}</h${b.level}>`;
    case 'p': return `<p>${inline(b.text)}</p>`;
    case 'ol': return `<ol start="${b.start}">${b.items.map(it => `<li>${inline(it.text)}${it.sub.length ? `<ul>${it.sub.map(s => `<li>${inline(s)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>`;
    case 'ul': return `<ul>${b.items.map(it => `<li>${inline(it)}</li>`).join('')}</ul>`;
    case 'img': return `<figure style="width:${b.w}%"><img src="${esc(imgDir(path.basename(b.src)))}" alt="${esc(b.alt)}"><figcaption>${inline(b.alt)}</figcaption></figure>`;
    case 'callout': return `<div class="callout ${b.kind}"><span class="ci">${ICON[b.kind]}</span><div><b class="cw">${WORD[b.kind]}</b> ${inline(b.text)}</div></div>`;
    case 'table': return `<table><thead><tr>${b.rows[0].map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.slice(1).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'card': return `<section class="card"><h3>${inline(b.title)}</h3>${b.blocks.map(x => block(x, imgDir)).join('')}</section>`;
    case 'word': return `<section class="word"><div class="wt"><h3>${inline(b.title)}</h3>${b.blocks.map(x => block(x, imgDir)).join('')}</div>${b.img ? `<div class="wp"><img src="${esc(imgDir(path.basename(b.img)))}" alt=""></div>` : ''}</section>`;
    default: return '';
  }
};

// Ids for the chapters and their sections (the table of contents and the PDF bookmarks).
const number = (chapters) => {
  chapters.forEach((c, i) => {
    c.id = `ch-${i}-${slug(c.title)}`;
    c.page = `p${i}`;
    for (const b of c.blocks) if (b.type === 'h') b.id = `${c.id}--${slug(b.text)}`;
  });
  return chapters;
};
const tocEntries = (chapters) => chapters.flatMap(c => [
  { level: 1, id: c.id, text: plain(c.title) },
  ...(c.kind === 'chapter' ? c.blocks.filter(b => b.type === 'h' && b.level === 2).map(b => ({ level: 2, id: b.id, text: plain(b.text) })) : [])
]);

const css = (chapters, meta) => `
@page { size: A4 portrait; margin: 22mm 20mm 20mm 20mm;
  @top-left { content: "IntelliSched Office Manual"; font: 600 8.5pt "Segoe UI", Arial, sans-serif; color: ${GREY}; vertical-align: bottom; padding-bottom: 3mm; }
  @bottom-left { content: "Version ${meta.version}"; font: 8.5pt "Segoe UI", Arial, sans-serif; color: ${GREY}; vertical-align: top; padding-top: 3mm; }
  @bottom-right { content: "Page " counter(page); font: 8.5pt "Segoe UI", Arial, sans-serif; color: ${GREY}; vertical-align: top; padding-top: 3mm; } }
@page cover { margin: 0; @top-left { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
@page toc { @top-right { content: "Contents"; font: 600 8.5pt "Segoe UI", Arial, sans-serif; color: ${GREY}; vertical-align: bottom; padding-bottom: 3mm; } }
${chapters.map(c => `@page ${c.page} { @top-right { content: "${plain(c.title).replace(/"/g, '\\"')}"; font: 600 8.5pt "Segoe UI", Arial, sans-serif; color: ${GREY}; vertical-align: bottom; padding-bottom: 3mm; } }`).join('\n')}
html { font-family: "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #0F172A; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; }
.cover { page: cover; height: 297mm; box-sizing: border-box; padding: 0; position: relative; break-after: page; }
.cover .band { background: ${NAVY}; color: #fff; padding: 70mm 22mm 18mm; }
.cover .band .kicker { font-size: 11pt; letter-spacing: .18em; text-transform: uppercase; opacity: .85; margin: 0 0 6mm; }
.cover h1 { font-size: 34pt; line-height: 1.1; margin: 0 0 6mm; color: #fff; }
.cover .band p.for { font-size: 14pt; margin: 0; }
.cover .stripe { height: 3mm; background: linear-gradient(90deg, ${BLUE}, #B91C1C, #F97316); }
.cover .meta { padding: 18mm 22mm; color: #334155; font-size: 12pt; }
.cover .meta p { margin: 0 0 3mm; }
.cover .meta .ver { font-size: 20pt; font-weight: 700; color: ${NAVY}; margin-bottom: 2mm; }
.cover .foot { position: absolute; left: 22mm; right: 22mm; bottom: 18mm; color: ${GREY}; font-size: 9.5pt; border-top: 0.5pt solid #CBD5E1; padding-top: 4mm; }
section.chapter { break-before: page; }
${chapters.map(c => `section.${c.page} { page: ${c.page}; }`).join('\n')}
section.toc { page: toc; break-before: page; }
h1 { font-size: 24pt; line-height: 1.15; color: ${NAVY}; margin: 0 0 3mm; }
.intro { color: ${GREY}; font-size: 12pt; margin: 0 0 8mm; padding-bottom: 4mm; border-bottom: 1.5pt solid ${BLUE}; }
h2 { font-size: 15pt; color: ${NAVY}; margin: 8mm 0 2.5mm; break-after: avoid; }
h3 { font-size: 12pt; color: #0F172A; margin: 5mm 0 2mm; break-after: avoid; }
p { margin: 0 0 3mm; }
ol, ul { margin: 0 0 3.5mm; padding-left: 7mm; }
li { margin: 0 0 1.6mm; padding-left: 1mm; }
ol > li::marker { color: ${BLUE}; font-weight: 700; }
b.ui { font-weight: 700; color: #0F172A; }
code { font-family: Consolas, monospace; font-size: 9.5pt; background: #F1F5F9; padding: 0 1mm; border-radius: 1mm; overflow-wrap: anywhere; }
figure { margin: 2mm auto 5mm; break-inside: avoid; }
figure img { display: block; width: 100%; max-height: 190mm; object-fit: contain; border: 0.5pt solid #CBD5E1; border-radius: 1.5mm; }
figcaption { color: ${GREY}; font-size: 9pt; margin-top: 1.5mm; text-align: center; }
.callout { display: flex; gap: 3mm; align-items: flex-start; margin: 2mm 0 4mm; padding: 2.5mm 4mm; border-radius: 2mm; break-inside: avoid; border-left: 1.2mm solid; }
.callout .ci { font-size: 13pt; line-height: 1.3; }
.callout.tip { background: #EFF6FF; border-color: ${BLUE}; }
.callout.careful { background: #FFF7ED; border-color: #EA580C; }
.callout.check { background: #F0FDF4; border-color: #16A34A; }
.callout .cw { margin-right: 1mm; }
table { width: 100%; border-collapse: collapse; margin: 2mm 0 5mm; font-size: 10pt; }
th, td { border-bottom: 0.5pt solid #CBD5E1; padding: 2mm 2.5mm; text-align: left; vertical-align: top; }
th { background: #EFF6FF; color: ${NAVY}; border-bottom: 1pt solid ${BLUE}; }
tr { break-inside: avoid; }
section.toc h1 { margin-bottom: 6mm; }
.toc-row { display: flex; align-items: baseline; gap: 2mm; margin: 0 0 1.2mm; }
.toc-row a { color: inherit; text-decoration: none; }
.toc-row .dots { flex: 1; border-bottom: 0.8pt dotted #94A3B8; transform: translateY(-1mm); }
.toc-row.l1 { font-weight: 700; font-size: 11.5pt; margin-top: 3.5mm; color: ${NAVY}; }
.toc-row.l2 { padding-left: 6mm; font-size: 10pt; color: #334155; }
.toc-row .pg { min-width: 7mm; text-align: right; }
section.quick { font-size: 9.6pt; line-height: 1.32; }
section.quick h1 { font-size: 20pt; }
section.quick .intro { margin-bottom: 4mm; font-size: 10.5pt; }
section.quick .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 3.5mm; }
section.quick .card { border: 0.8pt solid #BFDBFE; border-top: 1.4mm solid ${BLUE}; border-radius: 2mm; padding: 2.5mm 3.5mm; break-inside: avoid; }
section.quick .card h3 { margin: 0 0 1.5mm; color: ${NAVY}; font-size: 11pt; }
section.quick .card ol, section.quick .card ul { margin: 0; padding-left: 5mm; }
section.quick .card li { margin: 0 0 0.8mm; }
section.quick p.contact { margin-top: 4mm; font-weight: 600; }
section.glossary .word { display: flex; gap: 5mm; align-items: center; border-bottom: 0.5pt solid #E2E8F0; padding: 2mm 0; break-inside: avoid; }
section.glossary .wt { flex: 1; }
section.glossary .wt h3 { margin: 0 0 0.5mm; color: ${NAVY}; }
section.glossary .wt p { margin: 0; }
section.glossary .wp { width: 48mm; text-align: right; }
section.glossary .wp img { max-width: 48mm; max-height: 34mm; object-fit: contain; border: 0.5pt solid #CBD5E1; border-radius: 1mm; }
`;

const buildHtml = (chapters, meta, imgDir, pages = {}) => {
  number(chapters);
  const toc = tocEntries(chapters);
  const pg = (id) => (pages[id] ? String(pages[id]) : '00');
  const out = [];
  out.push(`<section class="cover"><div class="band"><p class="kicker">Laguna State Polytechnic University · Los Baños Campus</p><h1>IntelliSched Office Manual</h1><p class="for">for the Office of the Dean, College of Computer Studies</p></div><div class="stripe"></div><div class="meta"><p class="ver">Version ${esc(meta.version)}</p><p>${esc(meta.date)}</p><p>For the Dean and the College Secretary</p></div><div class="foot">IntelliSched schedules the classes, teachers and rooms of the College of Computer Studies (BSIT and BSCS).</div></section>`);
  const front = chapters.filter(c => c.kind === 'front');
  const rest = chapters.filter(c => c.kind !== 'front');
  const chapterHtml = (c) => `<section class="chapter ${c.page} ${c.kind}"><h1 id="${c.id}">${inline(c.title)}</h1>${c.intro ? `<p class="intro">${inline(c.intro)}</p>` : ''}${c.kind === 'quick'
    ? `<div class="cards">${c.blocks.filter(b => b.type === 'card').map(b => block(b, imgDir)).join('')}</div>${c.blocks.filter(b => b.type !== 'card').map(b => block(b, imgDir).replace('<p>', '<p class="contact">')).join('')}`
    : c.blocks.map(b => block(b, imgDir)).join('\n')}</section>`;
  out.push(...front.map(chapterHtml));
  out.push(`<section class="toc"><h1 id="contents">Contents</h1>${toc.filter(t => !front.some(f => f.id === t.id)).map(t => `<div class="toc-row l${t.level}"><a href="#${t.id}">${esc(t.text)}</a><span class="dots"></span><span class="pg">${pg(t.id)}</span></div>`).join('')}</section>`);
  out.push(...rest.map(chapterHtml));
  return { html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>IntelliSched Office Manual ${esc(meta.version)}</title><style>${css(chapters, meta)}</style></head><body>${out.join('\n')}</body></html>`, toc };
};

module.exports = { buildHtml, number, tocEntries };
