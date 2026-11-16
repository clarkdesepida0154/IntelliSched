// Phase 8 Part 13: the user manual in three formats, from ONE source, docs/USER_MANUAL.md.
//   npm run manual:build                 (repo root) writes docs/manual/IntelliSched-User-Manual.docx and .pdf
//   node scripts/manual/build-manual.js --check-strings   lists every quoted label and message of the manual
//                                        and where it was found (client/src, server/src, or the screen text
//                                        captured from the running system in docs/manual/screen-text/)
// No new package: the Word file is written as Word XML by hand and packed with the server's own ZIP writer
// (server/src/exports/zip.js, the one the office's forms use), and the PDF is the same content as one HTML
// file printed by the export code's headless Edge (server/src/exports/pdf.js htmlToPdf). The Markdown is
// read by a small converter for the subset the manual uses: headings, paragraphs, **bold**, `code`, links,
// numbered and bulleted lists (with indented continuation lines), images, tables and fenced code.
// Never edit the .docx or the .pdf by hand: change the Markdown and run this again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DOCS = path.join(REPO, 'docs');
const SOURCE = path.join(DOCS, 'USER_MANUAL.md');
const OUT_DIR = path.join(DOCS, 'manual');
const DOCX_FILE = path.join(OUT_DIR, 'IntelliSched-User-Manual.docx');
const PDF_FILE = path.join(OUT_DIR, 'IntelliSched-User-Manual.pdf');
const { zipSync, unzipSync } = require(path.join(REPO, 'server', 'src', 'exports', 'zip.js'));
const { htmlToPdf, pdfInfo } = require(path.join(REPO, 'server', 'src', 'exports', 'pdf.js'));

const TITLE = 'IntelliSched User Manual';
const SUBTITLE = 'For the Dean and the College Secretary';
const COLLEGE = 'College of Computer Studies, LSPU Los Baños';

// ------------------------------------------------------------------------------------------ Markdown
// Blocks: { type: 'h', level, text } | { type: 'p', text } | { type: 'li', kind: 'ol' | 'ul', level, list, text }
// | { type: 'cont', level, text } | { type: 'img', alt, src } | { type: 'table', rows } | { type: 'code', text }.
// A numbered list restarts after a heading or a paragraph that is not indented; an indented image, table or
// continuation line keeps the list going.
const parseMarkdown = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = null;
  let listId = 0;
  let inList = false;
  const flush = () => { if (para) { blocks.push(para); para = null; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i].replace(/^ {0,3}/, ''));
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flush(); inList = false;
      blocks.push({ type: 'h', level: m[1].length, text: m[2] });
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(t))) {
      flush();
      blocks.push({ type: 'img', alt: m[1], src: m[2], level: inList && indent ? 1 : 0 });
      continue;
    }
    if (t.startsWith('|')) {
      flush();
      const rows = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
        if (!cells.every(c => /^:?-{3,}:?$/.test(c))) rows.push(cells);
      }
      i--;
      blocks.push({ type: 'table', rows, level: inList && indent ? 1 : 0 });
      continue;
    }
    if ((m = /^(\d+)\.\s+(.*)$/.exec(t)) && indent < 3) {
      flush();
      if (!inList) listId++;
      inList = true;
      blocks.push({ type: 'li', kind: 'ol', level: 0, list: listId, text: m[2] });
      continue;
    }
    if ((m = /^[-*]\s+(.*)$/.exec(t))) {
      flush();
      const level = inList && indent >= 2 ? 1 : 0;
      if (level === 0) { inList = false; }
      blocks.push({ type: 'li', kind: 'ul', level, list: 0, text: m[1] });
      continue;
    }
    if (indent >= 3 && blocks.length && ['li', 'cont', 'img', 'table'].includes(blocks[blocks.length - 1].type) && !para) {
      blocks.push({ type: 'cont', level: 1, text: t });
      continue;
    }
    if (para && para.type === 'cont') { para.text += ` ${t}`; continue; }
    if (para) { para.text += ` ${t}`; continue; }
    if (indent === 0) inList = false;
    para = { type: 'p', text: t };
  }
  flush();
  // Fold continuation lines that follow one another into one paragraph.
  const out = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === 'cont' && last && last.type === 'cont' && !b.text.startsWith('**') && !/^(What you should see|Note)/.test(b.text)) last.text += ` ${b.text}`;
    else out.push(b);
  }
  return out;
};

// Inline: **bold**, `code`, [text](url) -> [{ text, bold, code }].
const inlineRuns = (text) => {
  const runs = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let at = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index) });
    if (m[1] !== undefined) runs.push(...inlineRuns(m[1]).map(r => ({ ...r, bold: true })));
    else if (m[2] !== undefined) runs.push({ text: m[2], code: true });
    else runs.push({ text: m[3] });
    at = re.lastIndex;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
};
const plainText = (text) => inlineRuns(text).map(r => r.text).join('');

// The manual's front matter is everything before the first "## " heading: the title page replaces it.
const sectionsOf = (blocks) => {
  const first = blocks.findIndex(b => b.type === 'h' && b.level === 2);
  return first < 0 ? blocks : blocks.slice(first);
};

const pngSize = (file) => {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(12) !== 0x49484452) throw new Error(`${file} is not a PNG.`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const imagePath = (src) => path.resolve(DOCS, src);

const gitShort = () => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim(); } catch { return 'unknown'; } };
const today = () => {
  const d = new Date();
  return `${d.getDate()} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()]} ${d.getFullYear()}`;
};
const slugOf = (text) => plainText(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ------------------------------------------------------------------------------------------ Word
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMU_PER_INCH = 914400;
const CONTENT_W_IN = 8.27 - 2; // A4 with 1-inch margins
const MAX_IMG_H_IN = 8.2;

const runXml = (r, extra = '') => {
  const props = `${r.bold ? '<w:b/>' : ''}${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="21"/>' : ''}${extra}`;
  return String(r.text).split('\n').map((part, i) => `${i ? '<w:r><w:br/></w:r>' : ''}<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(part)}</w:t></w:r>`).join('');
};
const runsXml = (text, extra) => inlineRuns(text).map(r => runXml(r, extra)).join('');
const para = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;

const buildDocx = (blocks, meta) => {
  const media = [];
  const bookmarks = [];
  const body = [];
  let bm = 0;
  let figure = 0;
  const numIds = new Map(); // list id -> w:num id
  const numFor = (list) => { if (!numIds.has(list)) numIds.set(list, numIds.size + 3); return numIds.get(list); };

  // Title page.
  body.push(para('', '<w:spacing w:before="2400"/>'));
  body.push(para(runXml({ text: TITLE }), '<w:pStyle w:val="Title"/>'));
  body.push(para(runXml({ text: SUBTITLE }), '<w:pStyle w:val="Subtitle"/>'));
  body.push(para(runXml({ text: COLLEGE }), '<w:pStyle w:val="Subtitle"/>'));
  body.push(para(runXml({ text: `Version ${meta.commit}, ${meta.date}` }), '<w:jc w:val="center"/><w:spacing w:before="1200"/>'));
  body.push(para('<w:r><w:br w:type="page"/></w:r>'));
  // Contents: a TOC field Word updates on open (settings.xml updateFields), pre-filled with the headings.
  body.push(para(runXml({ text: 'Contents' }), '<w:pStyle w:val="TOCHeading"/>'));
  const tocEntries = blocks.filter(b => b.type === 'h' && (b.level === 2 || b.level === 3));
  tocEntries.forEach((b, i) => {
    const anchor = `_Toc${String(i + 1).padStart(4, '0')}`;
    b.anchor = anchor;
    const start = i === 0 ? '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' : '';
    const end = i === tocEntries.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '';
    body.push(para(`${start}<w:hyperlink w:anchor="${anchor}" w:history="1">${runXml({ text: plainText(b.text) })}</w:hyperlink>${end}`, `<w:pStyle w:val="TOC${b.level - 1}"/>`));
  });

  let firstSection = true;
  for (const b of blocks) {
    if (b.type === 'h') {
      const style = { 2: 'Heading1', 3: 'Heading2', 4: 'Heading3' }[b.level] || 'Heading3';
      const pageBreak = b.level === 2 ? '<w:pageBreakBefore/>' : '';
      const id = ++bm;
      const name = b.anchor || `_H${id}`;
      bookmarks.push(name);
      body.push(para(`<w:bookmarkStart w:id="${id}" w:name="${name}"/>${runsXml(b.text)}<w:bookmarkEnd w:id="${id}"/>`, `<w:pStyle w:val="${style}"/>${pageBreak}`));
      firstSection = false;
    } else if (b.type === 'p') {
      body.push(para(runsXml(b.text)));
    } else if (b.type === 'li') {
      if (b.kind === 'ol') body.push(para(runsXml(b.text), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numFor(b.list)}"/></w:numPr>`));
      else body.push(para(runsXml(b.text), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${b.level}"/><w:numId w:val="2"/></w:numPr>`));
    } else if (b.type === 'cont') {
      body.push(para(runsXml(b.text), '<w:ind w:left="720"/>'));
    } else if (b.type === 'code') {
      body.push(para(runXml({ text: b.text, code: true }), '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:ind w:left="284" w:right="284"/>'));
    } else if (b.type === 'table') {
      const cols = Math.max(...b.rows.map(r => r.length));
      const total = Math.round((CONTENT_W_IN - (b.level ? 0.5 : 0)) * 1440);
      const w = Math.floor(total / cols);
      const rowsXml = b.rows.map((row, ri) => `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, ci) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E7EEF7"/>' : ''}</w:tcPr>${para(runsXml(row[ci] || '', ri === 0 ? '<w:b/>' : ''), '<w:spacing w:before="40" w:after="40"/>')}</w:tc>`).join('')}</w:tr>`).join('');
      body.push(`<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>${b.level ? '<w:tblInd w:w="720" w:type="dxa"/>' : ''}<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rowsXml}</w:tbl>`);
      body.push(para('', '<w:spacing w:after="0"/>'));
    } else if (b.type === 'img') {
      const file = imagePath(b.src);
      const { width, height } = pngSize(file);
      figure++;
      const n = media.length + 1;
      media.push({ name: `image${n}.png`, data: fs.readFileSync(file), rid: `rIdImg${n}` });
      let wIn = CONTENT_W_IN;
      let hIn = wIn * height / width;
      if (hIn > MAX_IMG_H_IN) { hIn = MAX_IMG_H_IN; wIn = hIn * width / height; }
      const cx = Math.round(wIn * EMU_PER_INCH);
      const cy = Math.round(hIn * EMU_PER_INCH);
      const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${n}" name="Figure ${n}" descr="${esc(b.alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="6350"><a:solidFill><a:srgbClr val="A6A6A6"/></a:solidFill></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
      body.push(para(drawing, '<w:keepNext/><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/>'));
      body.push(para(runsXml(b.alt), '<w:pStyle w:val="Caption"/>'));
    }
  }
  void firstSection;

  const sectPr = '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:titlePg/></w:sectPr>';
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  const font = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>';
  const style = (id, name, { type = 'paragraph', basedOn = 'Normal', rPr = '', pPr = '', next = 'Normal', outline } = {}) => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ''}<w:next w:val="${next}"/><w:qFormat/><w:pPr>${pPr}${outline !== undefined ? `<w:outlineLvl w:val="${outline}"/>` : ''}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr>${font}<w:sz w:val="24"/></w:rPr></w:style>
${style('Heading1', 'heading 1', { rPr: '<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/>', pPr: '<w:keepNext/><w:spacing w:before="240" w:after="200"/>', outline: 0 })}
${style('Heading2', 'heading 2', { rPr: '<w:b/><w:color w:val="1F3864"/><w:sz w:val="28"/>', pPr: '<w:keepNext/><w:spacing w:before="280" w:after="120"/>', outline: 1 })}
${style('Heading3', 'heading 3', { rPr: '<w:b/><w:sz w:val="24"/>', pPr: '<w:keepNext/><w:spacing w:before="200" w:after="80"/>', outline: 2 })}
${style('Title', 'Title', { rPr: '<w:b/><w:color w:val="1F3864"/><w:sz w:val="56"/>', pPr: '<w:jc w:val="center"/><w:spacing w:after="360"/>' })}
${style('Subtitle', 'Subtitle', { rPr: '<w:sz w:val="28"/>', pPr: '<w:jc w:val="center"/><w:spacing w:after="160"/>' })}
${style('Caption', 'caption', { rPr: '<w:i/><w:sz w:val="20"/>', pPr: '<w:jc w:val="center"/><w:spacing w:after="240"/>' })}
${style('ListParagraph', 'List Paragraph', { pPr: '<w:spacing w:after="80"/>' })}
${style('TOCHeading', 'TOC Heading', { rPr: '<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/>', pPr: '<w:spacing w:after="240"/>' })}
${style('TOC1', 'toc 1', { rPr: '<w:b/>', pPr: '<w:spacing w:before="120" w:after="40"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9016"/></w:tabs>' })}
${style('TOC2', 'toc 2', { pPr: '<w:ind w:left="240"/><w:spacing w:after="20"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9016"/></w:tabs>' })}
${style('Footer', 'footer', { pPr: '<w:jc w:val="center"/>', rPr: '<w:sz w:val="18"/>' })}
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F3864"/></w:rPr></w:style>
</w:styles>`;

  const lvl = (ilvl, fmt, text, indent) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>${fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : ''}</w:lvl>`;
  const nums = [...numIds.values()].map(id => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('');
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'decimal', '%1.', 720)}${lvl(1, 'bullet', '', 1440)}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'bullet', '', 720)}${lvl(1, 'bullet', '', 1440)}</w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>${nums}</w:numbering>`;

  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t xml:space="preserve">${esc(TITLE)} · Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(TITLE)}</dc:title><dc:subject>${esc(SUBTITLE)}</dc:subject><dc:creator>IntelliSched team</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${meta.iso}</dcterms:created></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>IntelliSched manual builder</Application></Properties>`;
  const zip = zipSync([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: stylesXml },
    { name: 'word/numbering.xml', data: numberingXml },
    { name: 'word/settings.xml', data: settingsXml },
    { name: 'word/footer1.xml', data: footerXml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    ...media.map(m => ({ name: `word/media/${m.name}`, data: m.data }))
  ]);
  return { zip, figures: figure };
};

// ------------------------------------------------------------------------------------------ HTML / PDF
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inlineHtml = (text) => inlineRuns(text).map(r => {
  const t = htmlEsc(r.text).replace(/\n/g, '<br>');
  if (r.code) return `<code>${t}</code>`;
  return r.bold ? `<strong>${t}</strong>` : t;
}).join('');

const buildHtml = (blocks, meta) => {
  const out = [];
  const toc = blocks.filter(b => b.type === 'h' && (b.level === 2 || b.level === 3));
  out.push(`<section class="title"><h1 class="doc-title">${htmlEsc(TITLE)}</h1><p class="sub">${htmlEsc(SUBTITLE)}</p><p class="sub">${htmlEsc(COLLEGE)}</p><p class="ver">Version ${htmlEsc(meta.commit)}, ${htmlEsc(meta.date)}</p></section>`);
  out.push(`<section class="toc"><h2 class="toc-title">Contents</h2>${toc.map(b => `<p class="toc${b.level}"><a href="#${slugOf(b.text)}">${htmlEsc(plainText(b.text))}</a></p>`).join('')}</section>`);
  let open = null; // 'ol' | 'ul'
  let openList = null;
  const close = () => { if (open) { out.push(`</li></${open}>`); open = null; openList = null; } };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'li' && b.level === 0) {
      if (open && (open !== b.kind || (b.kind === 'ol' && openList !== b.list))) close();
      if (!open) { out.push(`<${b.kind}>`); open = b.kind; openList = b.list; out.push(`<li>${inlineHtml(b.text)}`); }
      else out.push(`</li><li>${inlineHtml(b.text)}`);
      continue;
    }
    if (b.type === 'li' && b.level === 1) { out.push(`<ul class="sub"><li>${inlineHtml(b.text)}</li></ul>`); continue; }
    if (b.type === 'cont' && open) { out.push(`<p>${inlineHtml(b.text)}</p>`); continue; }
    if ((b.type === 'img' || b.type === 'table') && open && b.level) { out.push(renderBlock(b)); continue; }
    if (b.type === 'img' && open && blocks[i + 1] && blocks[i + 1].type === 'li' && blocks[i + 1].list === openList) { out.push(renderBlock(b)); continue; }
    close();
    out.push(renderBlock(b));
  }
  close();
  const css = `
@page { size: A4; margin: 25.4mm 25.4mm 25.4mm 25.4mm; @bottom-center { content: "${TITLE} · Page " counter(page); font: 9pt Arial, sans-serif; color: #444; } }
@page :first { @bottom-center { content: none; } }
html { font-family: Arial, Arimo, sans-serif; font-size: 12pt; line-height: 1.35; color: #111; }
body { margin: 0; }
h1, h2, h3, h4 { color: #1F3864; break-after: avoid; }
h2.sec { font-size: 16pt; break-before: page; margin: 0 0 10pt; }
h3 { font-size: 14pt; margin: 16pt 0 6pt; }
h4 { font-size: 12pt; color: #111; margin: 12pt 0 4pt; }
p { margin: 0 0 7pt; }
ol, ul { margin: 0 0 8pt; padding-left: 26pt; }
li { margin: 0 0 5pt; }
li p { margin: 3pt 0 4pt; }
ul.sub { margin: 2pt 0 2pt; }
code, pre { font-family: Consolas, monospace; font-size: 10.5pt; }
pre { background: #F2F2F2; padding: 6pt 8pt; white-space: pre-wrap; break-inside: avoid; }
figure { margin: 8pt 0 12pt; text-align: center; break-inside: avoid; }
figure img { max-width: 100%; max-height: 205mm; border: 0.5pt solid #A6A6A6; }
figcaption { font-size: 10pt; font-style: italic; margin-top: 4pt; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; font-size: 10.5pt; }
th, td { border: 0.5pt solid #A6A6A6; padding: 3pt 5pt; text-align: left; vertical-align: top; }
th { background: #E7EEF7; }
tr { break-inside: avoid; }
section.title { text-align: center; padding-top: 70mm; break-after: page; }
.doc-title { font-size: 28pt; margin-bottom: 18pt; }
.sub { font-size: 14pt; margin: 0 0 8pt; }
.ver { margin-top: 40mm; }
section.toc .toc-title { font-size: 16pt; }
section.toc p { margin: 0 0 3pt; }
section.toc .toc2 { font-weight: bold; margin-top: 7pt; }
section.toc .toc3 { padding-left: 14pt; }
section.toc a { color: #111; text-decoration: none; }
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEsc(TITLE)}</title><style>${css}</style></head><body>${out.join('\n')}</body></html>`;
};
function renderBlock(b) {
  if (b.type === 'h') {
    const tag = `h${b.level}`;
    return `<${tag}${b.level === 2 ? ' class="sec"' : ''} id="${slugOf(b.text)}">${inlineHtml(b.text)}</${tag}>`;
  }
  if (b.type === 'p' || b.type === 'cont') return `<p>${inlineHtml(b.text)}</p>`;
  if (b.type === 'li') return `<ul><li>${inlineHtml(b.text)}</li></ul>`;
  if (b.type === 'code') return `<pre>${htmlEsc(b.text)}</pre>`;
  if (b.type === 'table') return `<table><thead><tr>${b.rows[0].map(c => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.slice(1).map(r => `<tr>${r.map(c => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  if (b.type === 'img') return `<figure><img src="file:///${imagePath(b.src).replace(/\\/g, '/')}" alt="${htmlEsc(b.alt)}"><figcaption>${inlineHtml(b.alt)}</figcaption></figure>`;
  return '';
}

// ------------------------------------------------------------------------------------------ string check
// Every **bold** label and every "quoted" text of the manual (sections 2-11; the glossary and the backup
// commands are the manual's own words), looked up verbatim in client/src, server/src and the screen text
// captured from the running system (docs/manual/screen-text/). A text with "…" standing for a name or a
// number matches when each fixed part does.
const checkStrings = () => {
  const md = fs.readFileSync(SOURCE, 'utf8');
  const norm = (s) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\\u2019/g, '’').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/︎/g, '').replace(/\s+/g, ' ');
  const corpusOf = (dir, exts) => {
    const parts = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (exts.some(x => e.name.endsWith(x))) parts.push(fs.readFileSync(p, 'utf8'));
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return norm(parts.join('\n'));
  };
  const corpora = [
    ['client/src', corpusOf(path.join(REPO, 'client', 'src'), ['.js', '.jsx'])],
    ['server/src', corpusOf(path.join(REPO, 'server', 'src'), ['.js'])],
    ['scripts/demo', corpusOf(path.join(REPO, 'scripts', 'demo'), ['.js'])],
    ['screen', corpusOf(path.join(OUT_DIR, 'screen-text'), ['.txt'])]
  ];
  const start = md.indexOf('\n## 2.');
  const end = md.indexOf('\n## 12.');
  const body = md.slice(start, end > 0 ? end : undefined).replace(/```[\s\S]*?```/g, '').replace(/^#.*$/gm, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const quoted = new Set();
  for (const m of body.matchAll(/\*\*(.+?)\*\*/g)) quoted.add(m[1].replace(/"/g, ''));
  for (const m of body.matchAll(/"([^"\n]{2,})"/g)) quoted.add(m[1]);
  const results = [];
  for (const q of quoted) {
    const text = norm(q).trim();
    const where = corpora.find(([, c]) => c.includes(text));
    if (where) { results.push({ q, how: 'verbatim', where: where[0] }); continue; }
    const parts = text.split('…').map(s => s.trim()).filter(s => s.length >= 3);
    const partsOk = text.includes('…') && parts.length && parts.every(p => corpora.some(([, c]) => c.includes(p)));
    results.push({ q, how: partsOk ? 'fixed parts' : 'NOT FOUND', where: partsOk ? 'parts' : '' });
  }
  const missing = results.filter(r => r.how === 'NOT FOUND');
  for (const r of results) console.log(`${r.how === 'NOT FOUND' ? '✖' : '✔'} [${r.how}${r.where ? `, ${r.where}` : ''}] ${r.q}`);
  console.log(`\n${results.length} quoted strings, ${results.length - missing.length} matched (${results.filter(r => r.how === 'verbatim').length} verbatim, ${results.filter(r => r.how === 'fixed parts').length} by their fixed parts around "…").`);
  return missing.length === 0;
};

// ------------------------------------------------------------------------------------------ main
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

(async () => {
  if (process.argv.includes('--check-strings')) {
    process.exitCode = checkStrings() ? 0 : 1;
    return;
  }
  const builtAt = new Date();
  const meta = { commit: gitShort(), date: today(), iso: builtAt.toISOString().replace(/\.\d+Z$/, 'Z') };
  const blocks = sectionsOf(parseMarkdown(fs.readFileSync(SOURCE, 'utf8')));
  const imgs = blocks.filter(b => b.type === 'img');
  for (const b of imgs) if (!fs.existsSync(imagePath(b.src))) throw new Error(`The image ${b.src} is missing.`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { zip, figures } = buildDocx(blocks, meta);
  fs.writeFileSync(DOCX_FILE, zip);
  const parts = unzipSync(fs.readFileSync(DOCX_FILE));
  const mediaCount = [...parts.keys()].filter(k => k.startsWith('word/media/')).length;
  if (!parts.has('word/document.xml')) throw new Error('The .docx has no word/document.xml.');
  if (mediaCount !== figures) throw new Error(`The .docx holds ${mediaCount} images for ${figures} figures.`);

  const pdf = await htmlToPdf(buildHtml(blocks, meta), { timeoutMs: 300000 });
  fs.writeFileSync(PDF_FILE, pdf);
  const info = pdfInfo(pdf);

  const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');
  console.log(`Built ${builtAt.toISOString()} (local ${builtAt.toLocaleString()}) at commit ${meta.commit}.`);
  console.log(`Figures in the Markdown: ${imgs.length}; images in the .docx (word/media/): ${mediaCount}; PDF pages: ${info.pages}.`);
  for (const f of [SOURCE, DOCX_FILE, PDF_FILE]) console.log(`${sha(f)}  ${rel(f)} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
})().catch((err) => { console.error(err.message || err); process.exit(1); });
