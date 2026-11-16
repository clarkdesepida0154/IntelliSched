// Phase 15: the Office Manual as a Word file, written as Word XML by hand and packed with the gateway's own
// ZIP writer (server/src/exports/zip.js): no new package. Same content as the PDF: the cover, "How to use",
// the contents (a TOC field Word refreshes, pre-filled with the PDF's page numbers), every chapter on a new
// page, the callouts and Quick Card boxes as shaded one-cell tables, the pictures inline.
// Header: "IntelliSched Office Manual" on the left, the chapter (STYLEREF Heading 1) on the right.
// Footer: "Version 1.0.3" on the left, "Page N" on the right.
const fs = require('fs');
const path = require('path');
const { inlineRuns, plain } = require('./parse');

const REPO = path.resolve(__dirname, '..', '..');
const { zipSync } = require(path.join(REPO, 'server', 'src', 'exports', 'zip.js'));

const BLUE = '2563EB';
const NAVY = '1E3A8A';
const GREY = '64748B';
const FONT = 'Segoe UI';
const EMU = 914400;
const TEXT_W_IN = (210 - 40) / 25.4; // A4, 20 mm margins
const TEXT_TW = Math.round(TEXT_W_IN * 1440);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const jpegSize = (buf) => {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('Not a JPEG.');
};

const run = (r, extra = '') => {
  const props = `${r.bold ? '<w:b/>' : ''}${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/>' : ''}${extra}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
};
const runs = (text, extra = '') => inlineRuns(text).map(r => run(r, extra)).join('');
const p = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const shadedTable = (inner, { fill, border, width = TEXT_TW }) => `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblBorders><w:left w:val="single" w:sz="24" w:space="0" w:color="${border}"/><w:top w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${width}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>${inner}</w:tc></w:tr></w:tbl>${p('', '<w:spacing w:after="60"/>')}`;
const CALLOUT = { tip: ['💡 Tip', 'EFF6FF', BLUE], careful: ['⚠️ Careful', 'FFF7ED', 'EA580C'], check: ['✅ Check', 'F0FDF4', '16A34A'] };

const buildDocx = (chapters, meta, imgDir, pages) => {
  const media = [];
  const body = [];
  let bm = 0;
  const names = new Map();
  const nm = (id) => { if (!names.has(id)) names.set(id, `_Toc${String(names.size + 1).padStart(5, '0')}`); return names.get(id); };
  let numCount = 0;
  const nums = [];
  const picture = (file, widthPct, maxHIn, alt) => {
    const data = fs.readFileSync(file);
    const { width, height } = jpegSize(data);
    const n = media.length + 1;
    media.push({ name: `image${n}.jpg`, data, rid: `rIdImg${n}` });
    let wIn = TEXT_W_IN * widthPct / 100;
    let hIn = wIn * height / width;
    if (hIn > maxHIn) { hIn = maxHIn; wIn = hIn * width / height; }
    const cx = Math.round(wIn * EMU); const cy = Math.round(hIn * EMU);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${n}" name="Picture ${n}" descr="${esc(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="6350"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  const heading = (text, style, id, pageBreak) => {
    const n = ++bm;
    return p(`<w:bookmarkStart w:id="${n}" w:name="${id}"/>${runs(text)}<w:bookmarkEnd w:id="${n}"/>`, `<w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}`);
  };
  const blocks = (list) => {
    const out = [];
    for (const b of list) {
      if (b.type === 'h') out.push(heading(b.text, b.level === 2 ? 'Heading2' : 'Heading3', nm(b.id), false));
      else if (b.type === 'p') out.push(p(runs(b.text)));
      else if (b.type === 'ol') {
        const id = 10 + (++numCount);
        nums.push({ id, start: b.start });
        for (const it of b.items) {
          out.push(p(runs(it.text), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`));
          for (const s of it.sub) out.push(p(runs(s), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr>'));
        }
      } else if (b.type === 'ul') for (const it of b.items) out.push(p(runs(it), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'));
      else if (b.type === 'img') {
        out.push(p(picture(path.join(imgDir, path.basename(b.src)), b.w, 7.2, plain(b.alt)), '<w:keepNext/><w:jc w:val="center"/><w:spacing w:before="80" w:after="40"/>'));
        out.push(p(runs(b.alt), '<w:pStyle w:val="Caption"/>'));
      } else if (b.type === 'callout') {
        const [word, fill, border] = CALLOUT[b.kind];
        out.push(shadedTable(p(run({ text: `${word}  `, bold: true }) + runs(b.text), '<w:spacing w:after="0"/>'), { fill, border }));
      } else if (b.type === 'table') {
        const cols = Math.max(...b.rows.map(r => r.length));
        const longest = Array.from({ length: cols }, (_, ci) => Math.max(...b.rows.map(r => plain(r[ci] || '').length)));
        const share = longest.map(n => Math.max(n, 6));
        const total = share.reduce((a, n) => a + Math.sqrt(n), 0);
        const widths = share.map(n => Math.round(TEXT_TW * Math.sqrt(n) / total));
        const rows = b.rows.map((row, ri) => `<w:tr><w:trPr><w:cantSplit/>${ri === 0 ? '<w:tblHeader/>' : ''}</w:trPr>${Array.from({ length: cols }, (_, ci) => `<w:tc><w:tcPr><w:tcW w:w="${widths[ci]}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EFF6FF"/>' : ''}</w:tcPr>${p(runs(row[ci] || '', ri === 0 ? `<w:color w:val="${NAVY}"/>` : ''), `<w:spacing w:before="40" w:after="40"/>${ri === 0 ? '' : ''}`)}</w:tc>`).join('')}</w:tr>`).join('');
        out.push(`<w:tbl><w:tblPr><w:tblW w:w="${TEXT_TW}" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/><w:insideV w:val="nil"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`);
        out.push(p('', '<w:spacing w:after="60"/>'));
      } else if (b.type === 'card') {
        out.push(shadedTable(p(runs(b.title), `<w:pStyle w:val="BoxTitle"/>`) + blocks(b.blocks).join(''), { fill: 'F8FAFC', border: BLUE }));
      } else if (b.type === 'word') {
        const text = p(runs(b.title), '<w:pStyle w:val="BoxTitle"/>') + blocks(b.blocks).join('');
        const left = Math.round(TEXT_TW * 0.68); const right = TEXT_TW - left;
        const pic = b.img ? p(picture(path.join(imgDir, path.basename(b.img)), 26, 0.9, ''), '<w:jc w:val="right"/>') : p('');
        out.push(`<w:tbl><w:tblPr><w:tblW w:w="${TEXT_TW}" w:type="dxa"/><w:tblBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/><w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${left}"/><w:gridCol w:w="${right}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${left}" w:type="dxa"/></w:tcPr>${text}</w:tc><w:tc><w:tcPr><w:tcW w:w="${right}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${pic}</w:tc></w:tr></w:tbl>`);
      }
    }
    return out;
  };

  // The cover (no header or footer: titlePg).
  body.push(p('', '<w:spacing w:before="2600"/>'));
  body.push(p(run({ text: 'LAGUNA STATE POLYTECHNIC UNIVERSITY · LOS BAÑOS CAMPUS' }, `<w:color w:val="${GREY}"/><w:sz w:val="20"/>`), '<w:spacing w:after="240"/>'));
  body.push(p(run({ text: 'IntelliSched Office Manual' }), '<w:pStyle w:val="Title"/>'));
  body.push(p(run({ text: 'for the Office of the Dean, College of Computer Studies' }), '<w:pStyle w:val="Subtitle"/>'));
  body.push(p(run({ text: `Version ${meta.version}`, bold: true }, `<w:color w:val="${NAVY}"/><w:sz w:val="40"/>`), '<w:spacing w:before="1600" w:after="80"/>'));
  body.push(p(run({ text: meta.date }, '<w:sz w:val="24"/>')));
  body.push(p(run({ text: 'For the Dean and the College Secretary' }, '<w:sz w:val="24"/>')));

  const front = chapters.filter(c => c.kind === 'front');
  const rest = chapters.filter(c => c.kind !== 'front');
  const chapter = (c) => {
    body.push(heading(c.title, 'Heading1', nm(c.id), true));
    if (c.intro) body.push(p(runs(c.intro), '<w:pStyle w:val="Intro"/>'));
    body.push(...blocks(c.blocks));
  };
  front.forEach(chapter);
  // The contents: a TOC field, pre-filled with the entries and the PDF's page numbers.
  body.push(p(run({ text: 'Contents' }), '<w:pStyle w:val="TOCHeading"/><w:pageBreakBefore/>'));
  const entries = rest.flatMap(c => [{ level: 1, c, id: c.id, text: plain(c.title) }, ...(c.kind === 'chapter' ? c.blocks.filter(b => b.type === 'h' && b.level === 2).map(b => ({ level: 2, id: b.id, text: plain(b.text) })) : [])]);
  entries.forEach((e, i) => {
    const start = i === 0 ? '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' : '';
    const end = i === entries.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '';
    body.push(p(`${start}<w:hyperlink w:anchor="${nm(e.id)}" w:history="1">${run({ text: e.text })}<w:r><w:tab/></w:r>${run({ text: String(pages[e.id] || '') })}</w:hyperlink>${end}`, `<w:pStyle w:val="TOC${e.level}"/>`));
  });
  rest.forEach(chapter);

  const sectPr = '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:headerReference w:type="first" r:id="rIdHeaderFirst"/><w:footerReference w:type="first" r:id="rIdFooterFirst"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="510" w:gutter="0"/><w:titlePg/></w:sectPr>';
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  const font = `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>`;
  const style = (id, name, { rPr = '', pPr = '', outline, basedOn = 'Normal' } = {}) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/><w:next w:val="Normal"/><w:qFormat/><w:pPr>${pPr}${outline !== undefined ? `<w:outlineLvl w:val="${outline}"/>` : ''}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  const tabRight = `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${TEXT_TW}"/></w:tabs>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${font}<w:color w:val="0F172A"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${style('Heading1', 'heading 1', { rPr: `<w:b/><w:color w:val="${NAVY}"/><w:sz w:val="48"/>`, pPr: '<w:keepNext/><w:spacing w:before="0" w:after="120"/>', outline: 0 })}
${style('Heading2', 'heading 2', { rPr: `<w:b/><w:color w:val="${NAVY}"/><w:sz w:val="30"/>`, pPr: '<w:keepNext/><w:spacing w:before="320" w:after="100"/>', outline: 1 })}
${style('Heading3', 'heading 3', { rPr: '<w:b/><w:sz w:val="24"/>', pPr: '<w:keepNext/><w:spacing w:before="200" w:after="80"/>', outline: 2 })}
${style('BoxTitle', 'Box title', { rPr: `<w:b/><w:color w:val="${NAVY}"/><w:sz w:val="23"/>`, pPr: '<w:spacing w:before="0" w:after="60"/>' })}
${style('Intro', 'Chapter intro', { rPr: `<w:color w:val="${GREY}"/><w:sz w:val="24"/>`, pPr: `<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="${BLUE}"/></w:pBdr><w:spacing w:after="320"/>` })}
${style('Title', 'Title', { rPr: `<w:b/><w:color w:val="${NAVY}"/><w:sz w:val="68"/>`, pPr: '<w:spacing w:after="200"/>' })}
${style('Subtitle', 'Subtitle', { rPr: '<w:sz w:val="28"/>', pPr: '<w:spacing w:after="160"/>' })}
${style('Caption', 'caption', { rPr: `<w:color w:val="${GREY}"/><w:sz w:val="18"/>`, pPr: '<w:jc w:val="center"/><w:spacing w:after="200"/>' })}
${style('ListParagraph', 'List Paragraph', { pPr: '<w:spacing w:after="60"/>' })}
${style('TOCHeading', 'TOC Heading', { rPr: `<w:b/><w:color w:val="${NAVY}"/><w:sz w:val="48"/>`, pPr: '<w:spacing w:after="240"/>' })}
${style('TOC1', 'toc 1', { rPr: `<w:b/><w:color w:val="${NAVY}"/>`, pPr: `<w:spacing w:before="140" w:after="20"/>${tabRight}` })}
${style('TOC2', 'toc 2', { rPr: '<w:sz w:val="20"/>', pPr: `<w:ind w:left="360"/><w:spacing w:after="0"/>${tabRight}` })}
${style('Header', 'header', { rPr: `<w:b/><w:color w:val="${GREY}"/><w:sz w:val="17"/>`, pPr: `<w:tabs><w:tab w:val="right" w:pos="${TEXT_TW}"/></w:tabs><w:spacing w:after="0"/>` })}
${style('Footer', 'footer', { rPr: `<w:color w:val="${GREY}"/><w:sz w:val="17"/>`, pPr: `<w:tabs><w:tab w:val="right" w:pos="${TEXT_TW}"/></w:tabs><w:spacing w:after="0"/>` })}
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0F172A"/></w:rPr></w:style>
</w:styles>`;
  const lvl = (ilvl, fmt, text, indent) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr><w:rPr>${fmt === 'bullet' ? `<w:color w:val="${BLUE}"/>` : `<w:b/><w:color w:val="${BLUE}"/>`}</w:rPr></w:lvl>`;
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'decimal', '%1.', 500)}${lvl(1, 'bullet', '•', 1000)}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'bullet', '•', 500)}${lvl(1, 'bullet', '◦', 1000)}</w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>${nums.map(n => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`).join('')}</w:numbering>`;
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const fld = (instr, shown) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t xml:space="preserve">${esc(shown)}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}><w:p><w:pPr><w:pStyle w:val="Header"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="CBD5E1"/></w:pBdr></w:pPr><w:r><w:t>IntelliSched Office Manual</w:t></w:r><w:r><w:tab/></w:r>${fld('STYLEREF "heading 1" \\* MERGEFORMAT', '')}</w:p></w:hdr>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${W}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t xml:space="preserve">Version ${esc(meta.version)}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">Page </w:t></w:r>${fld('PAGE', '1')}</w:p></w:ftr>`;
  const emptyHdr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}><w:p/></w:hdr>`;
  const emptyFtr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${W}><w:p/></w:ftr>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rIdHeaderFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/><Relationship Id="rIdFooterFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;
  const ov = (part, type) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/>${ov('/word/document.xml', 'document.main')}${ov('/word/styles.xml', 'styles')}${ov('/word/numbering.xml', 'numbering')}${ov('/word/settings.xml', 'settings')}${ov('/word/header1.xml', 'header')}${ov('/word/header2.xml', 'header')}${ov('/word/footer1.xml', 'footer')}${ov('/word/footer2.xml', 'footer')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>IntelliSched Office Manual ${esc(meta.version)}</dc:title><dc:subject>For the Office of the Dean, College of Computer Studies</dc:subject><dc:creator>IntelliSched team</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${meta.iso}</dcterms:created></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>IntelliSched manual builder</Application></Properties>`;
  return { zip: zipSync([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: stylesXml },
    { name: 'word/numbering.xml', data: numberingXml },
    { name: 'word/settings.xml', data: settingsXml },
    { name: 'word/header1.xml', data: headerXml },
    { name: 'word/header2.xml', data: emptyHdr },
    { name: 'word/footer1.xml', data: footerXml },
    { name: 'word/footer2.xml', data: emptyFtr },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    ...media.map(m => ({ name: `word/media/${m.name}`, data: m.data }))
  ]), pictures: media.length };
};

module.exports = { buildDocx };
