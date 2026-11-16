// The DOCX writer (Phase 8 Part 2; since Part 9, decision 5, it writes the forms' sheets): a Word file that looks like the
// PDF in Word, in Google Docs and in LibreOffice. Each page is ONE table drawn from the page's bands
// (sheets.js): the table's columns are every x where a cell starts or ends, its rows every y, each row
// exact (hRule="exact", cantSplit), each cell's borders only where the model has them (0.5 pt), the
// same padding on all four sides (none), the lines already broken into paragraphs with no spacing and
// single line spacing. Nothing floats: the letterhead is an inline picture in its cell. A 1-pt
// paragraph sits between two pages' tables (two tables never touch) and carries the page break. The
// DRAFT line sits in the header part and the form code line in the footer part, inside the margins,
// so neither moves the body. Arial only; the package has settings.xml (compatibility mode 15),
// fontTable.xml, docProps and every part in [Content_Types].xml. Word draws; nothing here measures.
const fs = require('fs');
const path = require('path');
const { zipSync } = require('./zip');
const { placeCells, lineHeightMm, capOffsetMm } = require('./bands');

const TWIPS_PER_MM = 1440 / 25.4;
const EMU_PER_MM = 36000;
const tw = (mm) => Math.round(mm * TWIPS_PER_MM);
const FONT = 'Arial';
const BORDER_SZ = 4;          // eighths of a point: 0.5 pt
const SNAP = 2;               // twips: boundaries closer than this are one boundary

const esc = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const rPr = ({ pt, bold, italic, super: sup, color }) => {
  const parts = [`<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/>`];
  if (bold) parts.push('<w:b/><w:bCs/>');
  if (italic) parts.push('<w:i/><w:iCs/>');
  if (color) parts.push(`<w:color w:val="${color}"/>`);
  const sz = Math.round(pt * 2);
  parts.push(`<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`);
  if (sup) parts.push('<w:vertAlign w:val="superscript"/>');
  return `<w:rPr>${parts.join('')}</w:rPr>`;
};
const run = (text, style) => `<w:r>${rPr(style)}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

// A paragraph: no spacing, single line spacing (Arial's 1.149 em, as the HTML), its alignment.
const para = (runsXml, { align = 'left', pt = 1, pageBreakBefore = false, exactTwips = null, ind = null, tabs = null } = {}) => {
  const spacing = exactTwips ? `<w:spacing w:before="0" w:after="0" w:line="${exactTwips}" w:lineRule="exact"/>` : '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>';
  const jc = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
  return `<w:p><w:pPr>${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}<w:keepNext w:val="0"/><w:widowControl w:val="0"/>${tabs ? `<w:tabs>${tabs}</w:tabs>` : ''}${spacing}${ind ? `<w:ind w:left="${ind}" w:right="0" w:firstLine="0"/>` : '<w:ind w:left="0" w:right="0" w:firstLine="0"/>'}<w:jc w:val="${jc}"/>${rPr({ pt })}</w:pPr>${runsXml}</w:p>`;
};

const linePara = (line) => para(line.runs.map(r => run(r.text, { pt: line.pt, bold: r.bold, italic: r.italic, super: r.super })).join(''), { align: line.align, pt: line.pt });
const emptyPara = () => para('', { pt: 1, exactTwips: 20 });

// The letterhead picture, inline (never anchored), at its box's size.
const inlinePicture = (image, relId, id) => {
  const cx = Math.round(image.w * EMU_PER_MM);
  const cy = Math.round(image.h * EMU_PER_MM);
  return `<w:r>${rPr({ pt: 1 })}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Letterhead ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(path.basename(image.file))}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
};

// Sorted boundaries with near-duplicates joined; index lookup by nearest boundary.
const boundaries = (values) => {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) if (!out.length || v - out[out.length - 1] > SNAP) out.push(v);
  return out;
};
const indexOf = (list, v) => {
  let best = 0;
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i] - v) < Math.abs(list[best] - v)) best = i;
  return best;
};

const borderXml = (sides) => `<w:tcBorders>${['top', 'left', 'bottom', 'right'].map(side => (sides[side]
  ? `<w:${side} w:val="single" w:sz="${BORDER_SZ}" w:space="0" w:color="000000"/>`
  : `<w:${side} w:val="nil"/>`)).join('')}</w:tcBorders>`;

// One page's table. Returns { xml, rows, columns } (the tests read the numbers too).
//   origin: { x, y } in twips — the page's left margin and the table's top on the page.
const sheetTable = (sheet, { originX, originY, pictures }) => {
  const cells = placeCells(sheet).map(c => ({
    ...c,
    x0: tw(c.x) - originX,
    x1: tw(c.x + c.w) - originX,
    y0: tw(c.y) - originY,
    y1: tw(c.y + c.h) - originY
  })).filter(c => c.x1 > c.x0 && c.y1 > c.y0);
  const xs = boundaries([0, ...cells.flatMap(c => [c.x0, c.x1])]);
  const ys = boundaries([0, ...cells.flatMap(c => [c.y0, c.y1])]);
  const nCols = xs.length - 1;
  const nRows = ys.length - 1;
  const occupant = Array.from({ length: nRows }, () => new Array(nCols).fill(null));
  for (const c of cells) {
    c.c0 = indexOf(xs, c.x0); c.c1 = indexOf(xs, c.x1);
    c.r0 = indexOf(ys, c.y0); c.r1 = indexOf(ys, c.y1);
    if (c.c1 <= c.c0 || c.r1 <= c.r0) { c.skip = true; continue; }
    for (let r = c.r0; r < c.r1; r++) {
      for (let k = c.c0; k < c.c1; k++) {
        if (occupant[r][k]) throw new Error(`Two cells of one page overlap at row ${r}, column ${k}.`);
        occupant[r][k] = c;
      }
    }
  }
  const widths = xs.slice(1).map((x, i) => x - xs[i]);
  const heights = ys.slice(1).map((y, i) => y - ys[i]);
  const tc = (span, inner, { borders = {}, vMerge = null, vAlign = 'top' } = {}) => {
    const w = widths.slice(span.c0, span.c1).reduce((a, b) => a + b, 0);
    return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span.c1 - span.c0 > 1 ? `<w:gridSpan w:val="${span.c1 - span.c0}"/>` : ''}${vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : vMerge === 'continue' ? '<w:vMerge/>' : ''}${borderXml(borders)}<w:noWrap/><w:vAlign w:val="${vAlign}"/></w:tcPr>${inner}</w:tc>`;
  };
  // Phase 11.1: each stretch of the table's grid is drawn by ONE cell, the first (in reading order) to
  // carry it, so Word's border conflicts can't double or thicken a line. A stretch is one grid column
  // of a row boundary or one row of a column boundary; a merged box gives up, row by row, the sides an
  // earlier cell already drew.
  const drawn = new Set();
  const owned = (r, c, sides) => {
    const units = {
      top: Array.from({ length: c.c1 - c.c0 }, (_, i) => `h${r}:${c.c0 + i}`),
      bottom: Array.from({ length: c.c1 - c.c0 }, (_, i) => `h${r + 1}:${c.c0 + i}`),
      left: [`v${c.c0}:${r}`],
      right: [`v${c.c1}:${r}`]
    };
    const out = {};
    for (const side of ['top', 'left', 'bottom', 'right']) {
      out[side] = Boolean(sides[side]) && !units[side].every(u => drawn.has(u));
      if (out[side]) units[side].forEach(u => drawn.add(u));
    }
    return out;
  };
  const rowsXml = [];
  for (let r = 0; r < nRows; r++) {
    const tcs = [];
    for (let k = 0; k < nCols;) {
      const c = occupant[r][k];
      if (!c) {
        let end = k;
        while (end < nCols && !occupant[r][end]) end += 1;
        tcs.push(tc({ c0: k, c1: end }, emptyPara()));
        k = end;
        continue;
      }
      const first = r === c.r0;
      const last = r === c.r1 - 1;
      const multi = c.r1 - c.r0 > 1;
      const borders = owned(r, c, { left: c.borders.left, right: c.borders.right, top: first && c.borders.top, bottom: last && c.borders.bottom });
      let inner = emptyPara();
      if (first) {
        const paras = [];
        if (c.image) {
          const pic = pictures.use(c.image);
          paras.push(para(inlinePicture(c.image, pic.relId, pic.id), { pt: 1 }));
        }
        paras.push(...c.lines.map(linePara));
        if (paras.length) inner = paras.join('');
      }
      tcs.push(tc(c, inner, { borders, vMerge: multi ? (first ? 'restart' : 'continue') : null, vAlign: c.valign === 'center' ? 'center' : 'top' }));
      k = c.c1;
    }
    rowsXml.push(`<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${heights[r]}" w:hRule="exact"/></w:trPr>${tcs.join('')}</w:tr>`);
  }
  const width = widths.reduce((a, b) => a + b, 0);
  const noBorders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="nil"/>`).join('');
  const tblPr = `<w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:jc w:val="left"/><w:tblInd w:w="0" w:type="dxa"/><w:tblBorders>${noBorders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>`;
  const grid = `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  return { xml: `<w:tbl>${tblPr}${grid}${rowsXml.join('')}</w:tbl>`, widths, heights, columns: nCols, rows: nRows, width };
};

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

// The page geometry every sheet of one export shares: the left margin = the leftmost cell; the top
// margin = the first band's top less the 1-pt paragraph that precedes each page's table; the bottom
// margin leaves the last band and the closing paragraph on the page.
const PARA_GAP_TWIPS = 20;
const pageGeometry = (model) => {
  const all = model.pages.map(p => placeCells(p.sheet));
  const page = model.pages[0].sheet.page;
  const minX = Math.min(...all.flat().map(c => tw(c.x)));
  const maxX = Math.max(...all.flat().map(c => tw(c.x + c.w)));
  const minY = Math.min(...all.flat().map(c => tw(c.y)));
  const maxY = Math.max(...all.flat().map(c => tw(c.y + c.h)));
  const pageW = tw(page.w);
  const pageH = tw(page.h);
  return {
    pageW,
    pageH,
    orient: page.orient,
    left: minX,
    right: Math.max(0, pageW - maxX),
    top: minY - PARA_GAP_TWIPS,
    bottom: Math.max(0, pageH - maxY - 2 * PARA_GAP_TWIPS - 40),
    tableTop: minY
  };
};

// The Word header part (the DRAFT line) and footer part (the form code line), each placed by its
// distance from the paper's edge so its capitals land where the PDF draws them.
const headerPart = (sheet) => {
  const d = sheet.draft;
  const body = d ? para(run(d.text, { pt: d.pt, bold: true, color: '990000' }), { align: 'center', pt: d.pt }) : para('', { pt: 1 });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${NS}>${body}</w:hdr>`;
};
const footerPart = (sheet, geo) => {
  const f = sheet.footer;
  if (!f) return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${NS}>${para('', { pt: 1 })}</w:ftr>`;
  // The first item starts at its x (the paragraph's indent); every other item sits on a tab stop of its
  // own alignment. Tab stops count from the margin, not from the indent.
  const [first, ...rest] = f.items.filter(i => i.text);
  const ind = first ? tw(first.x) - geo.left : 0;
  const tabs = rest.map(i => `<w:tab w:val="${i.align === 'center' ? 'center' : i.align === 'right' ? 'right' : 'left'}" w:pos="${tw(i.x) - geo.left}"/>`).join('');
  const style = { pt: f.pt };
  const tabRun = `<w:r>${rPr(style)}<w:tab/></w:r>`;
  const runs = [first ? run(first.text, style) : '', ...rest.map(i => tabRun + run(i.text, style))].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${NS}>${para(runs, { pt: f.pt, ind: Math.max(0, ind), tabs })}</w:ftr>`;
};
const headerDistance = (sheet) => (sheet.draft ? tw(sheet.draft.capTop - capOffsetMm(sheet.draft.pt)) : 200);
const footerDistance = (sheet, geo) => {
  const f = sheet.footer;
  if (!f) return 200;
  return Math.max(0, geo.pageH - tw(f.capTop - capOffsetMm(f.pt) + lineHeightMm(f.pt)));
};

const stylesXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:kern w:val="0"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

const settingsXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/><w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat></w:settings>`;

const fontTableXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="${FONT}"><w:panose1 w:val="020B0604020202020204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font></w:fonts>`;

const coreXml = (title) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>IntelliSched</dc:creator><cp:lastModifiedBy>IntelliSched</cp:lastModifiedBy></cp:coreProperties>`;
const appXml = (pages) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>IntelliSched</Application><Pages>${pages}</Pages><DocSecurity>0</DocSecurity></Properties>`;

const TITLES = { 'class-schedule': 'Class Schedule', 'room-schedule': 'Room Schedule', 'teachers-program': "Teachers' Program" };

// One export model (every page with its sheet) -> the .docx bytes. Returns { buffer, pages, tables }.
const writeSheetsDocx = (model) => {
  const geo = pageGeometry(model);
  const media = new Map();
  let drawingId = 0;
  const pictures = {
    use: (image) => {
      if (!media.has(image.file)) media.set(image.file, { relId: `rIdImg${media.size + 1}`, name: `image${media.size + 1}.png`, data: fs.readFileSync(image.file) });
      drawingId += 1;
      return { relId: media.get(image.file).relId, id: drawingId };
    }
  };
  const tables = [];
  const body = model.pages.map((page, i) => {
    const t = sheetTable(page.sheet, { originX: geo.left, originY: geo.tableTop, pictures });
    tables.push(t);
    // The 1-pt paragraph before each page's table carries the page break (after the first page).
    return para('', { pt: 1, exactTwips: PARA_GAP_TWIPS, pageBreakBefore: i > 0 }) + t.xml;
  }).join('') + para('', { pt: 1, exactTwips: PARA_GAP_TWIPS });
  const first = model.pages[0].sheet;
  const sectPr = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/><w:pgSz w:w="${geo.pageW}" w:h="${geo.pageH}"${geo.orient === 'landscape' ? ' w:orient="landscape"' : ''} w:code="9"/><w:pgMar w:top="${geo.top}" w:right="${geo.right}" w:bottom="${geo.bottom}" w:left="${geo.left}" w:header="${headerDistance(first)}" w:footer="${footerDistance(first, geo)}" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}${sectPr}</w:body></w:document>`;
  const ct = (part, type) => `<Override PartName="${part}" ContentType="${type}"/>`;
  const WP = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${ct('/word/document.xml', `${WP}.document.main+xml`)}${ct('/word/styles.xml', `${WP}.styles+xml`)}${ct('/word/settings.xml', `${WP}.settings+xml`)}${ct('/word/fontTable.xml', `${WP}.fontTable+xml`)}${ct('/word/header1.xml', `${WP}.header+xml`)}${ct('/word/footer1.xml', `${WP}.footer+xml`)}${ct('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml')}${ct('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml')}</Types>`;
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const docRels = [
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/>`,
    `<Relationship Id="rIdFonts" Type="${REL}/fontTable" Target="fontTable.xml"/>`,
    `<Relationship Id="rIdHdr" Type="${REL}/header" Target="header1.xml"/>`,
    `<Relationship Id="rIdFtr" Type="${REL}/footer" Target="footer1.xml"/>`,
    ...[...media.values()].map(m => `<Relationship Id="${m.relId}" Type="${REL}/image" Target="media/${m.name}"/>`)
  ].join('');
  const parts = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRels}</Relationships>` },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/settings.xml', data: settingsXml() },
    { name: 'word/fontTable.xml', data: fontTableXml() },
    { name: 'word/header1.xml', data: headerPart(first) },
    { name: 'word/footer1.xml', data: footerPart(first, geo) },
    { name: 'docProps/core.xml', data: coreXml(`${TITLES[model.view] || 'Schedule'} — ${model.schedule.semesterLabel} AY ${model.schedule.academicYear}`) },
    { name: 'docProps/app.xml', data: appXml(model.pages.length) },
    ...[...media.values()].map(m => ({ name: `word/media/${m.name}`, data: m.data }))
  ];
  return { buffer: zipSync(parts), pages: model.pages.length, tables, geometry: geo };
};

module.exports = { writeDocx: writeSheetsDocx, writeSheetsDocx, sheetTable, pageGeometry, TWIPS_PER_MM };
