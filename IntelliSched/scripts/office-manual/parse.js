// Phase 15: the Office Manual's content files (docs/office-manual/content/*.md) read into chapters of blocks.
// The subset used:
//   # Title {.front|.quick|.glossary}     a chapter (a new page); "> …" right after it is the chapter's intro line
//   ## / ###                              sections
//   1. / - lines                          numbered steps (the first number is kept) and bullets
//   ![caption](images/x.jpg){w=60}       a picture, w = percent of the text width (default 100)
//   !tip / !careful / !check text         the three callout boxes
//   | a | b |                             tables
//   ::: card Title … :::                  a Quick Card box;  ::: word Term | images/x.jpg … :::  a glossary entry
// Inline: **UI name** (checked against the app), __emphasis__ (bold, not a UI name), `code`.
const fs = require('fs');
const path = require('path');

const CONTENT = path.resolve(__dirname, '..', '..', 'docs', 'office-manual', 'content');

const parseFile = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chapters = [];
  let ch = null;
  let para = null;
  let box = null; // the open ::: block
  const target = () => (box ? box.blocks : ch.blocks);
  const flush = () => { if (para) { target().push(para); para = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    let m;
    if ((m = /^#\s+(.*?)(?:\s+\{\.(\w+)\})?$/.exec(line))) {
      flush();
      ch = { title: m[1], kind: m[2] || 'chapter', intro: '', blocks: [] };
      chapters.push(ch);
      continue;
    }
    if (!ch) continue;
    if ((m = /^:::\s+(card|word)\s+(.*)$/.exec(line))) {
      flush();
      const [title, img] = m[2].split('|').map(s => s.trim());
      box = { type: m[1], title, img: img || null, blocks: [] };
      continue;
    }
    if (/^:::\s*$/.test(line)) { flush(); ch.blocks.push(box); box = null; continue; }
    if (!line.trim()) { flush(); continue; }
    if ((m = /^>\s+(.*)$/.exec(line)) && !ch.intro && ch.blocks.length === 0) { ch.intro = m[1]; continue; }
    if ((m = /^(#{2,3})\s+(.*)$/.exec(line))) { flush(); target().push({ type: 'h', level: m[1].length, text: m[2] }); continue; }
    if ((m = /^!\[([^\]]*)\]\(([^)]+)\)(?:\{w=(\d+)\})?$/.exec(line.trim()))) { flush(); target().push({ type: 'img', alt: m[1], src: m[2], w: m[3] ? Number(m[3]) : 100 }); continue; }
    if ((m = /^!(tip|careful|check)\s+(.*)$/.exec(line))) { flush(); target().push({ type: 'callout', kind: m[1], text: m[2] }); continue; }
    if (line.trim().startsWith('|')) {
      flush();
      const rows = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        if (!cells.every(c => /^:?-{3,}:?$/.test(c))) rows.push(cells);
      }
      i--;
      target().push({ type: 'table', rows });
      continue;
    }
    if ((m = /^(\d+)\.\s+(.*)$/.exec(line))) {
      flush();
      const last = target()[target().length - 1];
      if (last && last.type === 'ol' && !last.closed) last.items.push({ text: m[2], sub: [] });
      else target().push({ type: 'ol', start: Number(m[1]), items: [{ text: m[2], sub: [] }] });
      continue;
    }
    if ((m = /^(\s*)-\s+(.*)$/.exec(line))) {
      flush();
      const last = target()[target().length - 1];
      if (m[1].length >= 2 && last && last.type === 'ol') { last.items[last.items.length - 1].sub.push(m[2]); continue; }
      if (last && last.type === 'ul') last.items.push(m[2]);
      else target().push({ type: 'ul', items: [m[2]] });
      continue;
    }
    // A paragraph (or the next line of one). A list ends at a paragraph or a picture.
    const last = target()[target().length - 1];
    if (last && last.type === 'ol') last.closed = true;
    if (para) para.text += ` ${line.trim()}`;
    else para = { type: 'p', text: line.trim() };
  }
  flush();
  return chapters;
};

// A numbered list that continues after a picture (the steps go on) keeps its own start number.
const readContent = () => fs.readdirSync(CONTENT).filter(f => f.endsWith('.md')).sort()
  .flatMap(f => parseFile(fs.readFileSync(path.join(CONTENT, f), 'utf8')));

// Inline runs: **ui** -> { text, bold, ui }, __em__ -> { text, bold }, `code` -> { text, code }.
const inlineRuns = (text) => {
  const runs = [];
  const re = /\*\*(.+?)\*\*|__([^_].*?)__|`([^`]+)`/g;
  let at = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true, ui: true });
    else if (m[2] !== undefined) runs.push({ text: m[2], bold: true });
    else runs.push({ text: m[3], code: true });
    at = re.lastIndex;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
};
const plain = (text) => inlineRuns(text).map(r => r.text).join('');

module.exports = { readContent, inlineRuns, plain, CONTENT };
