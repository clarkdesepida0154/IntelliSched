// Phase 15, chapter 4: assigning teachers (By class, a professor's classes, Teaching loads, Recommendations).
const { scene, shot, go, tid, choose, dump } = require('./shoot');
const { modal, ensureDean, soft } = require('./scenes');

const confirmIfAsked = async (p, re) => {
  await p.waitForTimeout(700);
  const dlg = p.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true });
  if (await dlg.count()) {
    const btn = dlg.last().getByRole('button', { name: re });
    if (await btn.count()) { await btn.last().click(); await p.waitForTimeout(1200); return true; }
  }
  return false;
};

scene('by-class', async () => {
  const p = await ensureDean();
  await go(p, 'assign-faculty?tab=by-class', 'Assign Faculty');
  await tid(p, 'matrix-table').waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
  await shot(p, 'c4-by-class', { clip: 'full', marks: [{ t: 'assign-tab-by-class', n: 1, at: 'tl' }, { t: 'matrix-filter-section-button', n: 2, at: 'tl' }, { t: 'matrix-filter-professor-button', n: 3, at: 'tl' }, { t: 'matrix-count-major', n: 4, at: 'tl' }] });
  await tid(p, 'matrix-filter-section-button').click();
  await p.waitForTimeout(400);
  await shot(p, 'c4-section-picker', { clip: ['matrix-filter-section-button', 'matrix-filter-section-list'], pad: 16, marks: [{ t: 'matrix-filter-section-button', n: 2, at: 'tl' }] });
  await p.keyboard.press('Escape');
  // One class's professor picker: every professor with their hours against their range.
  const row = 'matrix-assign-ITEC-103-BSCS-1A';
  await tid(p, `${row}-button`).click();
  await p.waitForTimeout(400);
  await shot(p, 'c4-row-picker', { clip: [`${row}-button`, `${row}-list`], pad: 16, marks: [{ t: `${row}-button`, n: 1, at: 'tl' }] });
  await p.keyboard.press('Escape');
  // Release it, then take the ranking's top pick (Accept).
  if (await p.getByTestId('matrix-release-ITEC-103-BSCS-1A').count()) {
    await tid(p, 'matrix-release-ITEC-103-BSCS-1A').click();
    await confirmIfAsked(p, /Release/);
  }
  await p.waitForTimeout(2500);
  await tid(p, 'matrix-class-ITEC-103-BSCS-1A').scrollIntoViewIfNeeded();
  const rowEl = p.getByTestId('matrix-class-ITEC-103-BSCS-1A');
  await p.getByTestId('matrix-accept-ITEC-103-BSCS-1A').waitFor({ timeout: 120000 }).catch(() => {});
  await shot(p, 'c4-open-class', { clip: rowEl, pad: 12, marks: [{ t: `${row}-button`, n: 1, at: 'tl' }, { t: 'matrix-top-ITEC-103-BSCS-1A', n: 2, at: 'tl', optional: true }, { t: 'matrix-accept-ITEC-103-BSCS-1A', n: 3, at: 'tl', optional: true }] });
  if (await p.getByTestId('matrix-accept-ITEC-103-BSCS-1A').count()) {
    await p.getByTestId('matrix-accept-ITEC-103-BSCS-1A').click();
  } else {
    await choose(p, row, await p.locator(`[data-testid="${row}"] option`).nth(1).getAttribute('value'));
    await tid(p, `${row}-assign`).click();
  }
  await confirmIfAsked(p, /Assign|Accept|Save/);
  await p.waitForTimeout(2500);
  await shot(p, 'c4-assigned', { clip: rowEl, pad: 12, marks: [{ t: 'matrix-release-ITEC-103-BSCS-1A', n: 4, at: 'tl', optional: true }] });
  // The section's top picks button.
  await soft('accept-all', async () => {
    const all = tid(p, 'matrix-accept-section');
    await all.scrollIntoViewIfNeeded();
    await shot(p, 'c4-accept-all', { clip: all, pad: 30, marks: [{ t: all, n: 5, at: 'tl' }] });
  });
  // One professor's classes across the sections.
  await soft('professor-view', async () => {
    const value = await p.locator('[data-testid="matrix-filter-professor"] option').nth(1).getAttribute('value');
    await choose(p, 'matrix-filter-professor', value);
    await p.waitForTimeout(1800);
    await shot(p, 'c4-professor-view', { clip: 'full', marks: [{ t: 'matrix-filter-professor-button', n: 1, at: 'tl' }, { t: 'matrix-col-section', n: 2, at: 'tl', optional: true }, { t: 'matrix-professor-clear', n: 3, at: 'tl', optional: true }] });
    if (await tid(p, 'matrix-professor-clear').count()) await tid(p, 'matrix-professor-clear').click();
  });
});

scene('loads', async () => {
  const p = await ensureDean();
  await go(p, 'assign-faculty?tab=by-class', 'Assign Faculty');
  await tid(p, 'pt-loads-toggle').click();
  await tid(p, 'pt-loads-panel').waitFor({ timeout: 60000 });
  await p.getByTestId('pt-loads-loading').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await tid(p, 'pt-loads-toggle').scrollIntoViewIfNeeded();
  await shot(p, 'c4-loads', { clip: { x: 270, y: 60, width: 1096, height: 708 }, scrollTo: 'pt-loads-toggle', marks: [{ t: 'pt-loads-toggle', n: 1, at: 'tl' }, { t: 'pt-loads-table', n: 2, at: 'tl', highlight: false, optional: true }] });
  await soft('balance-all', async () => {
    const btn = p.getByRole('button', { name: /^Balance all/ }).first();
    await btn.scrollIntoViewIfNeeded();
    await shot(p, 'c4-balance-all', { clip: ['pt-loads-suggestion'], pad: 12, marks: [{ t: btn, n: 3, at: 'tl' }] });
    await btn.click();
    await tid(p, 'pt-loads-confirm').waitFor({ timeout: 15000 });
    await shot(p, 'c4-balance-confirm', { clip: 'pt-loads-confirm', pad: 10, marks: [{ t: 'pt-loads-confirm-apply', n: 4, at: 'tl' }, { t: 'pt-loads-confirm-keep', n: 5, at: 'tl' }] });
    // The plan is applied: every ticked move goes through the Overload Guardian as the Dean's choice.
    await tid(p, 'pt-loads-confirm-apply').click();
    await p.waitForTimeout(6000);
    await soft('balance-applied', () => shot(p, 'c4-balance-applied', { clip: 'pt-loads-panel', pad: 8, marks: [{ t: 'pt-loads-applied', n: 6, at: 'tl', optional: true }] }));
  });
});

scene('recommendations', async () => {
  const p = await ensureDean();
  // An open class first: CMSC 204 for BSCS 2A gets its professor through the ranking.
  await go(p, 'assign-faculty?tab=by-class', 'Assign Faculty');
  await tid(p, 'matrix-table').waitFor({ timeout: 60000 });
  await choose(p, 'matrix-filter-section', await p.locator('[data-testid="matrix-filter-section"] option').filter({ hasText: /^BSCS 2A/ }).first().getAttribute('value'));
  await p.waitForTimeout(1500);
  if (await p.getByTestId('matrix-release-CMSC-204-BSCS-2A').count()) {
    await p.getByTestId('matrix-release-CMSC-204-BSCS-2A').click();
    await confirmIfAsked(p, /Release/);
    await p.waitForTimeout(2000);
  }
  await tid(p, 'assign-tab-recommendations').click();
  await p.getByTestId('ranking-loading').waitFor({ state: 'detached', timeout: 240000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await tid(p, 'ranking-search').fill('CMSC 204');
  await p.waitForTimeout(1200);
  const approve = p.getByRole('button', { name: /^Approve .* for CMSC 204 BSCS 2A$/ }).first();
  await approve.waitFor({ timeout: 60000 });
  const rowEl = p.locator('tr').filter({ has: approve }).first();
  await shot(p, 'c4-recommendations', { clip: 'full', scrollTo: approve, marks: [{ t: 'assign-tab-recommendations', n: 1, at: 'tl' }, { t: 'ranking-search', n: 2, at: 'tl' }, { t: rowEl.getByTestId('ranking-likelihood').first(), n: 3, at: 'tl', optional: true }, { t: approve, n: 4, at: 'tl' }] });
  await soft('ranking-row', () => shot(p, 'c4-ranking-row', { clip: rowEl, pad: 10, marks: [{ t: rowEl.getByTestId('ranking-likelihood').first(), n: 3, at: 'tl', optional: true }, { t: rowEl.getByTestId('ranking-reason').first(), n: 5, at: 'tl', optional: true }, { t: approve, n: 4, at: 'tl' }] }));
  // Review: every other professor, for a different choice.
  await soft('review', async () => {
    const review = rowEl.getByRole('button', { name: /Review/ }).first();
    await review.click();
    await p.waitForTimeout(1500);
    await shot(p, 'c4-review', { clip: modal(p), pad: 6, marks: [{ t: 'review-likelihood-1', n: 1, at: 'tl', optional: true }] });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(500);
    if (await modal(p).count()) await modal(p).getByRole('button', { name: /Cancel|Close/ }).first().click().catch(() => {});
  });
  await approve.click();
  await p.waitForTimeout(1000);
  if (await p.getByTestId('ranking-confirm').count()) {
    await soft('approve-confirm', () => shot(p, 'c4-approve-confirm', { clip: 'ranking-confirm', pad: 8 }));
    await p.getByTestId('ranking-confirm').getByRole('button', { name: /Approve|Assign|Confirm/ }).last().click();
  }
  await p.waitForTimeout(3000);
  await soft('approved', () => shot(p, 'c4-approved', { clip: p.locator('tr').filter({ hasText: 'CMSC 204' }).first(), pad: 10 }));
  await dump(p, 'after-recommendations');
});
