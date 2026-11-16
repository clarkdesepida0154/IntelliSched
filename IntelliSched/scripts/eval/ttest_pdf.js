#!/usr/bin/env node
// Phase 14 Part A: prints docs/evaluation/ttest-approved-format/source/ttest-results.html (written by
// scripts/eval/ttest_approved_format.py) to IntelliSched-Paired-TTest-Results.pdf with the installed Edge,
// through Playwright, the way the Office Manual (Phase 15) is printed. A4; the margins come from the
// page's @page rule (1.5 in left, 1 in elsewhere). No new package.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DIR = path.join(REPO, 'docs', 'evaluation', 'ttest-approved-format');
const HTML = path.join(DIR, 'source', 'ttest-results.html');
const PDF = path.join(DIR, 'IntelliSched-Paired-TTest-Results.pdf');

(async () => {
  if (!fs.existsSync(HTML)) throw new Error('Run scripts/eval/ttest_approved_format.py first.');
  const { chromium } = require(path.join(REPO, 'client', 'node_modules', '@playwright', 'test'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file:///${HTML.replace(/\\/g, '/')}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
    fs.writeFileSync(PDF, pdf);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log(`Wrote ${path.relative(REPO, PDF)} (${pages} pages).`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
