// Which fonts the forms use (Phase 8 Part 2, decision 3; since Part 9, decision 5: Arial only). The PDF
// draws Arial, or the bundled Arimo (Arial's metric twin, the same widths) under the name Arial when
// Arial is not installed, and the export says so in one line. Arial Narrow and Old English Text MT are
// checked only for the letterhead pictures (scripts/forms/build-letterheads.js), which carry the
// university's name in blackletter as pixels. Proprietary font files are never bundled.
const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, 'fonts');

// The system font files that prove a family is installed (Windows names; a per-user install lands in
// %LOCALAPPDATA%\Microsoft\Windows\Fonts with the same file names).
const SYSTEM_FILES = {
  arial: ['arial.ttf', 'ARIAL.TTF'],
  arialNarrow: ['ARIALN.TTF', 'arialn.ttf', 'ARIALN0.TTF'],
  oldEnglish: ['OLDENGL.TTF', 'oldengl.ttf']
};

const LOOK_ALIKES = {
  arial: { family: 'Arial', file: 'Arimo-wght.ttf', name: 'Arimo' },
  arialNarrow: { family: 'Arial Narrow', file: 'ArchivoNarrow-wght.ttf', name: 'Archivo Narrow' },
  oldEnglish: { family: 'Old English Text MT', file: 'PirataOne-Regular.ttf', name: 'Pirata One' }
};

const fontDirs = () => {
  if (process.platform === 'win32') {
    return [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts'),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : null
    ].filter(Boolean);
  }
  // Elsewhere the Microsoft families are not expected; the look-alikes are used.
  return [];
};

const installed = (key) => fontDirs().some(dir => SYSTEM_FILES[key].some(file => {
  try { return fs.existsSync(path.join(dir, file)); } catch { return false; }
}));

// The families the PDF itself draws (decision 5): Arial only.
const PDF_FAMILIES = ['arial'];

// Per family, whether the real font is installed, and otherwise the look-alike it falls back to.
// `substituted` lists, in words for the Export card, only what the PDF draws ("Arial shown as Arimo").
const checkFonts = () => {
  const families = {};
  const substituted = [];
  for (const key of Object.keys(LOOK_ALIKES)) {
    const has = installed(key);
    families[key] = { installed: has, lookAlike: has ? null : LOOK_ALIKES[key].name };
    if (!has && PDF_FAMILIES.includes(key)) substituted.push(`${LOOK_ALIKES[key].family} shown as ${LOOK_ALIKES[key].name}`);
  }
  return { families, substituted };
};

// @font-face rules for the missing families only, each under the REAL family name, with the bundled
// file embedded as base64 (the HTML the PDF is printed from is self-contained). A variable-weight
// file serves 100–900.
const fontFaceCss = (check = checkFonts()) => Object.entries(LOOK_ALIKES)
  .filter(([key]) => PDF_FAMILIES.includes(key) && !check.families[key]?.installed)
  .map(([, { family, file }]) => {
    let data;
    try { data = fs.readFileSync(path.join(FONT_DIR, file)); } catch { return ''; }
    return `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${data.toString('base64')}) format('truetype');font-weight:100 900;}`;
  })
  .filter(Boolean)
  .join('\n');

module.exports = { checkFonts, fontFaceCss, LOOK_ALIKES, PDF_FAMILIES };
