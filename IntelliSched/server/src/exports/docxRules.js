// Phase 8 Part 9, Step 5: the Word rules of decision 5 as one checker over any export's DOCX bytes.
// It returns the list of problems (empty = the file follows every rule): the tests run it on every
// export and on planted problems, and the system check runs it on every DOCX it writes.
const { unzipSync } = require('./zip');

const text = (parts, name) => parts.get(name).toString('utf8');

const checkDocx = (buffer) => {
  const problems = [];
  const parts = unzipSync(buffer);
  const xmlNames = [...parts.keys()].filter(n => n.endsWith('.xml') || n.endsWith('.rels'));
  const doc = parts.has('word/document.xml') ? text(parts, 'word/document.xml') : '';

  // Nothing floats: no anchored picture, text box or frame, in any part.
  for (const name of xmlNames) {
    const xml = text(parts, name);
    if (/<wp:anchor\b/.test(xml)) problems.push(`${name}: an anchored (floating) picture`);
    if (/<w:txbxContent\b|<wps:txbx\b|<v:textbox\b/.test(xml)) problems.push(`${name}: a text box`);
    if (/<w:framePr\b/.test(xml)) problems.push(`${name}: a frame`);
    if (/<w:pict\b|<v:shape\b|mc:AlternateContent/.test(xml)) problems.push(`${name}: a drawing shape`);
  }

  // Arial only: every font name in any part.
  for (const name of xmlNames) {
    const xml = text(parts, name);
    const fonts = [...xml.matchAll(/<w:rFonts ([^>]*)\/>/g)].flatMap(m => [...m[1].matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]*)"/g)].map(x => x[1]));
    const tableFonts = [...xml.matchAll(/<w:font w:name="([^"]*)"/g)].map(m => m[1]);
    for (const f of [...fonts, ...tableFonts]) if (f !== 'Arial') problems.push(`${name}: the font "${f}" (Arial only)`);
  }

  // Tables.
  const tables = doc.split('<w:tbl>').slice(1).map(t => t.slice(0, t.indexOf('</w:tbl>')));
  if (!tables.length) problems.push('document.xml: no table');
  if (/<\/w:tbl>\s*<w:tbl>/.test(doc)) problems.push('document.xml: two tables touch (no paragraph between them)');
  if (/<\/w:tbl>\s*(<w:sectPr|<\/w:body>)/.test(doc)) problems.push('document.xml: a table at the end of the body with no paragraph after it');
  tables.forEach((tbl, i) => {
    const label = `table ${i + 1}`;
    if (!/<w:tblLayout w:type="fixed"\/>/.test(tbl)) problems.push(`${label}: not a fixed layout`);
    const tblW = Number(/<w:tblW w:w="(\d+)" w:type="dxa"\/>/.exec(tbl)?.[1]);
    const grid = [...(/<w:tblGrid>(.*?)<\/w:tblGrid>/s.exec(tbl)?.[1] || '').matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => Number(m[1]));
    if (!Number.isFinite(tblW)) problems.push(`${label}: no table width`);
    else if (grid.reduce((a, b) => a + b, 0) !== tblW) problems.push(`${label}: the grid's columns add up to ${grid.reduce((a, b) => a + b, 0)}, not the table's ${tblW}`);
    if (grid.length > 63) problems.push(`${label}: ${grid.length} columns (Word's limit is 63)`);
    if (!/<w:tblCellMar><w:top w:w="(\d+)" w:type="dxa"\/><w:left w:w="\1" w:type="dxa"\/><w:bottom w:w="\1" w:type="dxa"\/><w:right w:w="\1" w:type="dxa"\/><\/w:tblCellMar>/.test(tbl)) {
      problems.push(`${label}: the cell padding is not the same on all four sides`);
    }
    const rows = [...tbl.matchAll(/<w:tr>(.*?)<\/w:tr>/gs)].map(m => m[1]);
    rows.forEach((row, r) => {
      const h = /<w:trHeight w:val="(\d+)"( w:hRule="(\w+)")?\/>/.exec(row);
      if (!h || h[3] !== 'exact') problems.push(`${label} row ${r + 1}: the height is not "exact"`);
      if (!/<w:cantSplit\/>/.test(row)) problems.push(`${label} row ${r + 1}: the row can split`);
      // The row's cells (a vertically merged continuation still has its width) add up to the table.
      const width = [...row.matchAll(/<w:tcW w:w="(\d+)" w:type="dxa"\/>/g)].reduce((a, m) => a + Number(m[1]), 0);
      if (Number.isFinite(tblW) && width !== tblW) problems.push(`${label} row ${r + 1}: the cells add up to ${width}, not ${tblW}`);
    });
  });
  if (/w:hRule="atLeast"|w:hRule="auto"/.test(doc)) problems.push('document.xml: an "at least" row height');
  if (/<w:sectPr\b/.test(doc.replace(/<w:sectPr>(?:(?!<\/w:sectPr>).)*<\/w:sectPr>\s*<\/w:body>/s, ''))) problems.push('document.xml: a section break');
  const firstPara = [...doc.matchAll(/<w:p>(.*?)<\/w:p>/gs)].map(m => m[1]);
  firstPara.forEach(p => {
    if (/<w:spacing [^>]*w:before="(?!0")/.test(p) || /<w:spacing [^>]*w:after="(?!0")/.test(p)) problems.push('document.xml: a paragraph with spacing before or after');
  });

  // The package.
  for (const name of ['word/settings.xml', 'word/fontTable.xml', 'docProps/core.xml', 'docProps/app.xml', 'word/styles.xml', 'word/header1.xml', 'word/footer1.xml']) {
    if (!parts.has(name)) problems.push(`the package has no ${name}`);
  }
  if (parts.has('word/settings.xml')) {
    const settings = text(parts, 'word/settings.xml');
    if (!/w:name="compatibilityMode"[^>]*w:val="15"/.test(settings)) problems.push('settings.xml: not compatibility mode 15');
    if (!/<w:defaultTabStop w:val="\d+"\/>/.test(settings)) problems.push('settings.xml: no default tab stop');
  }
  if (parts.has('word/styles.xml') && !/<w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial"/.test(text(parts, 'word/styles.xml'))) problems.push('styles.xml: the default font is not Arial');
  if (parts.has('[Content_Types].xml')) {
    const types = text(parts, '[Content_Types].xml');
    for (const name of parts.keys()) {
      if (name === '[Content_Types].xml') continue;
      const ext = name.slice(name.lastIndexOf('.') + 1);
      const byDefault = new RegExp(`<Default Extension="${ext}" `).test(types) && ext !== 'xml';
      if (!byDefault && !types.includes(`PartName="/${name}"`)) problems.push(`[Content_Types].xml: no content type for ${name}`);
    }
  } else problems.push('the package has no [Content_Types].xml');
  // Every relationship target of the document exists.
  if (parts.has('word/_rels/document.xml.rels')) {
    for (const m of text(parts, 'word/_rels/document.xml.rels').matchAll(/Target="([^"]+)"/g)) {
      if (!parts.has(`word/${m[1]}`)) problems.push(`document.xml.rels: ${m[1]} is not in the package`);
    }
  }
  // The page: the body (tables) fits between the margins.
  const pg = /<w:pgSz w:w="(\d+)" w:h="\d+"/.exec(doc);
  const mar = /<w:pgMar w:top="\d+" w:right="(\d+)" w:bottom="\d+" w:left="(\d+)"/.exec(doc);
  if (pg && mar && tables.length) {
    const tblW = Number(/<w:tblW w:w="(\d+)"/.exec(tables[0])?.[1]);
    if (tblW > Number(pg[1]) - Number(mar[1]) - Number(mar[2]) + 2) problems.push('document.xml: the table is wider than the page between its margins');
  }
  return problems;
};

module.exports = { checkDocx };
