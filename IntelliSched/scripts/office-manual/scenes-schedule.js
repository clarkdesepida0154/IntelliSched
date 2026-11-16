// Phase 15, chapters 5-7: the Readiness Check, generating, the Schedule Views & Editor (move, swap, change
// professor, TBA rooms), Versions, Approval, the Audit Trail, Print Outputs and Output Settings.
const fs = require('fs');
const path = require('path');
const { scene, shot, go, tid, choose, dump, ctx, L, S } = require('./shoot');
const { modal, ensureDean, soft } = require('./scenes');

const outputs = async (p) => {
  const token = await p.evaluate(() => localStorage.getItem('intellisched_token'));
  const r = await L.apiCall(ctx, 'GET', '/schedule/outputs?academicYear=2026-2027&semester=2&prefer=draft', token);
  if (!r.ok) throw new Error(`outputs ${r.status}`);
  return r.json;
};
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

scene('readiness', async () => {
  const p = await ensureDean();
  await go(p, 'readiness', 'Readiness Check');
  await p.getByTestId('readiness-verdict').waitFor({ timeout: 120000 });
  await p.waitForTimeout(1200);
  await shot(p, 'c5-readiness', { clip: 'full', marks: [{ t: 'readiness-verdict-label', n: 1, at: 'tl' }, { t: 'readiness-line-9', n: 2, at: 'tl', optional: true }, { t: 'readiness-fix-9', n: 3, at: 'tl', optional: true }] });
});

scene('generate', async () => {
  const p = await ensureDean();
  await go(p, 'generate', 'Generate Schedule');
  await p.getByTestId('readiness-verdict').waitFor({ timeout: 120000 });
  await p.waitForTimeout(800);
  await tid(p, 'generate-button').scrollIntoViewIfNeeded();
  await shot(p, 'c5-generate', { clip: 'full', scrollTo: 'generate-button', marks: [{ t: 'generate-button', n: 1, at: 'tl' }, { t: 'generate-advanced-toggle', n: 2, at: 'tl', highlight: false }] });
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 3) {
      // A third try with a fixed seed under "Advanced (system team)" so the pictures always show a clean run.
      await tid(p, 'generate-advanced-toggle').click();
      await tid(p, 'ga-seed').waitFor({ timeout: 60000 });
      await tid(p, 'ga-seed').fill('2');
    }
    await tid(p, 'generate-button').click();
    if (await p.getByTestId('generate-confirm').isVisible({ timeout: 2500 }).catch(() => false)) {
      if (attempt === 1) await soft('generate-confirm', () => shot(p, 'c5-generate-confirm', { clip: 'generate-confirm', pad: 8 }));
      await tid(p, 'generate-confirm-confirm').click();
    }
    await p.getByTestId('generate-progress').waitFor({ timeout: 60000 });
    if (attempt === 1) { await p.waitForTimeout(4000); await soft('progress', () => shot(p, 'c5-progress', { clip: 'generate-progress', pad: 16, marks: [{ t: 'generate-progress-line', n: 1, at: 'tl' }, { t: 'ga-cancel', n: 2, at: 'tl', optional: true }] })); }
    await p.locator('[data-testid="generate-result"][data-status]').waitFor({ timeout: 10 * 60000 });
    await p.waitForFunction(() => /^(done|failed|cancelled)$/.test(document.querySelector('[data-testid="generate-result"]')?.getAttribute('data-status') || ''), null, { timeout: 10 * 60000 });
    const status = await p.getByTestId('generate-result').getAttribute('data-status');
    const title = (await p.getByTestId('generate-result-title').innerText()).trim();
    console.log(`  run ${attempt}: ${status} - ${title}`);
    if (status === 'done' && /^No conflicts/.test(title)) break;
    if (attempt === 1) await soft('result-failed', () => shot(p, 'c5-result-conflicts', { clip: 'generate-result', pad: 12 }));
  }
  await p.waitForTimeout(1000);
  await tid(p, 'generate-result').scrollIntoViewIfNeeded();
  await shot(p, 'c5-result', { clip: 'generate-result', pad: 14, marks: [{ t: 'generate-result-title', n: 1, at: 'tl' }] });
});

scene('views', async () => {
  const p = await ensureDean();
  await go(p, 'schedule-views', 'Schedule Views & Editor');
  await tid(p, 'views-tab-section').click();
  const out = await outputs(p);
  const sec = out.sections.find(s => /BSIT 1A/.test(s.label || s.code || s.name)) || out.sections[0];
  await tid(p, `views-picker-item-${sec.id || sec.key}`).click().catch(async () => { await p.locator('[data-testid^="views-picker-item-"]').first().click(); });
  await p.waitForTimeout(1800);
  await shot(p, 'c5-views', { clip: 'full', marks: [{ t: 'views-version-button', n: 1, at: 'tl' }, { t: 'views-tab-section', n: 2, at: 'tl' }, { t: 'views-tab-professor', n: 3, at: 'tl' }, { t: 'views-tab-room', n: 4, at: 'tl' }, { t: 'views-picker', n: 5, at: 'tl', highlight: false }, { t: 'views-mode-list', n: 6, at: 'tl' }] });
  await soft('mother-table', async () => {
    const table = tid(p, 'views-table');
    await table.scrollIntoViewIfNeeded();
    await shot(p, 'c5-mother-schedule', { clip: { x: 300, y: 60, width: 1066, height: 708 }, alignTop: 'views-entity-title' });
  });
  await soft('teachers-program', async () => {
    await tid(p, 'views-tab-professor').click();
    await p.waitForTimeout(800);
    await p.locator('[data-testid^="views-picker-item-"]').first().click();
    await p.waitForTimeout(1800);
    await shot(p, 'c5-teachers-program', { clip: 'full', marks: [{ t: 'views-tab-professor', n: 1, at: 'tl' }, { t: 'views-load-range', n: 2, at: 'tl', optional: true }] });
  });
  await soft('room-program', async () => {
    await tid(p, 'views-tab-room').click();
    await p.waitForTimeout(800);
    await p.locator('[data-testid^="views-picker-item-"]').filter({ hasText: 'LAB 1' }).first().click();
    await p.waitForTimeout(1800);
    await shot(p, 'c5-room-program', { clip: 'full', marks: [{ t: 'views-tab-room', n: 1, at: 'tl' }, { t: 'views-week-filter', n: 2, at: 'tl', optional: true }, { t: 'views-room-hours', n: 3, at: 'tl', optional: true }] });
    // TBA rooms to request, and Fill TBA rooms when there are any.
    await soft('tba', async () => {
      const head = p.locator('[data-testid="views-tba-header"], [data-testid="views-tba-none"], [data-testid="views-tba-request"]').filter({ visible: true }).first();
      await head.scrollIntoViewIfNeeded();
      await shot(p, 'c5-tba-rooms', { clip: head, pad: 30, marks: [{ t: 'views-fill-tba', n: 1, at: 'tl', optional: true }] });
      if (await p.getByTestId('views-fill-tba').filter({ visible: true }).count() && await tid(p, 'views-fill-tba').isEnabled()) {
        await tid(p, 'views-fill-tba').click();
        await tid(p, 'views-fill-panel').waitFor({ timeout: 20000 });
        await shot(p, 'c5-fill-tba', { clip: 'views-fill-panel', pad: 8, marks: [{ t: 'views-fill-preview', n: 2, at: 'tl', optional: true }, { t: 'views-fill-save', n: 3, at: 'tl', optional: true }] });
        await tid(p, 'views-fill-cancel').click().catch(() => {});
      }
    });
  });
  await soft('list', async () => {
    await tid(p, 'views-tab-section').click();
    await tid(p, 'views-mode-list').click();
    await p.waitForTimeout(1500);
    await shot(p, 'c5-list', { clip: 'full', marks: [{ t: 'views-mode-list', n: 1, at: 'tl' }, { t: 'list-search', n: 2, at: 'tl', optional: true }, { t: 'list-filter-day-button', n: 3, at: 'tl', optional: true }] });
    await tid(p, 'views-mode-table').click();
  });
});

scene('move', async () => {
  const p = await ensureDean();
  await go(p, 'schedule-views', 'Schedule Views & Editor');
  const out = await outputs(p);
  const policy = out.policy;
  const movable = (c) => !c.isFixed && (policy.weekdays || []).includes(c.day) && c.type !== 'OJT';
  // A class whose section has another class on another day: moving it onto that class is refused.
  let pick = null;
  for (const section of out.sections) {
    const classes = out.classes.filter(c => c.sectionId === section.id && movable(c));
    const cls = classes.find(c => c.durationSlots * policy.slotMinutes <= 120);
    const other = cls && classes.find(o => o.itemId !== cls.itemId && o.day !== cls.day && o.subjectId !== cls.subjectId);
    if (cls && other) { pick = { section, cls, other }; break; }
  }
  if (!pick) throw new Error('No class to move.');
  S.moveSection = pick.section;
  await tid(p, 'views-tab-section').click();
  await tid(p, `views-picker-item-${pick.section.id}`).click();
  await p.waitForTimeout(1500);
  const block = tid(p, `views-block-${pick.cls.itemId}`);
  await block.scrollIntoViewIfNeeded();
  await shot(p, 'c5-click-class', { clip: { x: 300, y: 60, width: 1066, height: 708 }, scrollTo: block, marks: [{ t: block, n: 1, at: 'tl' }] });
  await block.click();
  await tid(p, 'move-panel').waitFor({ timeout: 20000 });
  const length = pick.cls.durationSlots * policy.slotMinutes;
  const clashStart = Math.min(toMin(pick.other.startTime), toMin(policy.dayEnd) - length);
  await p.getByTestId('move-day').selectOption(pick.other.day);
  await p.getByTestId('move-start').selectOption(fromMin(clashStart));
  await p.getByTestId('move-check-message').waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  await shot(p, 'c5-move-refused', { clip: 'move-panel', pad: 8, marks: [{ t: 'move-day-button', n: 2, at: 'tl' }, { t: 'move-start-button', n: 3, at: 'tl' }, { t: 'move-check-message', n: 4, at: 'tl' }, { t: 'move-submit', n: 5, at: 'tl' }] });
  // Now a free place: try the weekdays and starts until the check allows it.
  const starts = await p.locator('[data-testid="move-start"] option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
  let ok = false;
  for (const day of policy.weekdays) {
    for (const st of starts) {
      if (day === pick.cls.day && st === pick.cls.startTime) continue;
      await p.getByTestId('move-day').selectOption(day);
      await p.getByTestId('move-start').selectOption(st);
      await p.waitForTimeout(400);
      await p.waitForFunction(() => { const b = document.querySelector('[data-testid="move-check"]'); return !b || !/Checking/i.test(b.innerText); }, null, { timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(600);
      if (await tid(p, 'move-submit').isEnabled()) { ok = true; break; }
    }
    if (ok) break;
  }
  if (!ok) throw new Error('No free place found for the move.');
  await shot(p, 'c5-move-ok', { clip: 'move-panel', pad: 8, marks: [{ t: 'move-check', n: 4, at: 'tl', optional: true }, { t: 'move-submit', n: 5, at: 'tl' }] });
  await tid(p, 'move-submit').click();
  await p.waitForTimeout(1200);
  const conf = p.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true }).filter({ hasText: /Save|move/i });
  if (await conf.count()) { await conf.last().getByRole('button', { name: /Save/ }).last().click().catch(() => {}); }
  await p.getByTestId('views-toast').waitFor({ timeout: 30000 }).catch(() => {});
  await soft('move-saved', () => shot(p, 'c5-move-saved', { clip: 'views-toast', pad: 10 }));
});

scene('swap-and-professor', async () => {
  const p = await ensureDean();
  await go(p, 'schedule-views', 'Schedule Views & Editor');
  const out = await outputs(p);
  const policy = out.policy;
  const section = S.moveSection || out.sections[0];
  const classes = out.classes.filter(c => c.sectionId === section.id && !c.isFixed && (policy.weekdays || []).includes(c.day) && c.type !== 'OJT');
  await tid(p, 'views-tab-section').click();
  await tid(p, `views-picker-item-${section.id}`).click();
  await p.waitForTimeout(1500);
  const major = classes.find(c => c.facultyRef || c.professorId) || classes[0];
  await soft('swap', async () => {
    await tid(p, `views-block-${major.itemId}`).click();
    await tid(p, 'move-panel').waitFor({ timeout: 20000 });
    await shot(p, 'c5-move-actions', { clip: 'move-panel', pad: 8, marks: [{ t: 'move-action-professor', n: 1, at: 'tl' }, { t: 'move-action-swap', n: 2, at: 'tl' }] });
    await tid(p, 'move-action-swap').click();
    await tid(p, 'swap-panel').waitFor({ timeout: 20000 });
    const options = await p.locator('[data-testid="swap-with"] option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
    let ok = false;
    for (const v of options.slice(0, 12)) {
      await p.getByTestId('swap-with').selectOption(v);
      await p.waitForTimeout(2200);
      if (await tid(p, 'swap-submit').isEnabled()) { ok = true; break; }
    }
    await shot(p, 'c5-swap', { clip: 'swap-panel', pad: 8, marks: [{ t: 'swap-with-button', n: 3, at: 'tl' }, { t: 'swap-places', n: 4, at: 'tl', optional: true }, { t: 'swap-submit', n: 5, at: 'tl' }] });
    if (ok) {
      await tid(p, 'swap-submit').click();
      await p.waitForTimeout(1200);
      const conf = p.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true });
      if (await conf.count()) await conf.last().getByRole('button', { name: /Swap|Save/ }).last().click().catch(() => {});
      await p.waitForTimeout(2500);
    } else await tid(p, 'swap-cancel').click().catch(() => {});
  });
  await soft('change-professor', async () => {
    await go(p, 'schedule-views', 'Schedule Views & Editor');
    const fresh = await outputs(p);
    const cls = fresh.classes.find(c => c.sectionId === section.id && c.facultyRef && !c.isFixed && c.type !== 'OJT') || fresh.classes.find(c => c.facultyRef);
    await tid(p, 'views-tab-section').click();
    await tid(p, `views-picker-item-${cls.sectionId}`).click();
    await p.waitForTimeout(1500);
    await tid(p, `views-block-${cls.itemId}`).click();
    await tid(p, 'move-panel').waitFor({ timeout: 20000 });
    await tid(p, 'move-action-professor').click();
    await tid(p, 'professor-panel').waitFor({ timeout: 20000 });
    await p.getByTestId('professor-loading').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
    await p.waitForTimeout(1500);
    await shot(p, 'c5-change-professor', { clip: 'professor-panel', pad: 8, marks: [{ t: 'professor-options', n: 1, at: 'tl', highlight: false }, { t: 'professor-submit', n: 2, at: 'tl' }] });
    await tid(p, 'professor-cancel').click().catch(() => {});
  });
  // Check the whole schedule again.
  await soft('check-all', async () => {
    await tid(p, 'views-check-all').click();
    await tid(p, 'views-check-result').waitFor({ timeout: 120000 });
    await p.waitForTimeout(800);
    await shot(p, 'c5-check-all', { clip: ['views-check-all', 'views-check-result'], pad: 14, marks: [{ t: 'views-check-all', n: 1, at: 'tl' }, { t: 'views-check-result', n: 2, at: 'tl' }] });
  });
});

scene('versions', async () => {
  const p = await ensureDean();
  await go(p, 'versions', 'Versions');
  await tid(p, 'versions-table').waitFor({ timeout: 30000 });
  await shot(p, 'c5-versions', { clip: 'versions-table', pad: 16, padY: 60, marks: [{ t: p.locator('[data-testid^="version-details-"]').first(), n: 1, at: 'tl' }, { t: p.locator('[data-testid^="version-restore-"]').first(), n: 2, at: 'tl' }] });
  await soft('version-details', async () => {
    await p.locator('[data-testid^="version-details-"]').first().click();
    await p.waitForTimeout(1200);
    await shot(p, 'c5-version-details', { clip: modal(p), pad: 6 });
    await p.keyboard.press('Escape');
  });
});

scene('approval', async () => {
  const p = await ensureDean();
  // The Draft prints marked DRAFT – NOT APPROVED.
  await soft('draft-print', async () => {
    await go(p, 'print-outputs', 'Print Outputs');
    await tid(p, 'po-draft-note').waitFor({ timeout: 30000 });
    await shot(p, 'c6-draft-note', { clip: 'po-draft-note', pad: 14 });
  });
  await go(p, 'approval', 'Approval');
  const signoff = tid(p, 'approval-signoff');
  await signoff.waitFor({ timeout: 60000 });
  await p.waitForTimeout(1200);
  const checkNow = tid(p, 'approval-check-now');
  if ((await checkNow.innerText()).includes('Check now')) {
    await shot(p, 'c6-approval', { clip: 'full', marks: [{ t: 'approval-check-now', n: 1, at: 'tl' }, { t: 'approval-signoff', n: 2, at: 'tl' }] });
    await checkNow.click();
    await p.getByTestId('approval-check-result').filter({ hasText: /conflicts, checked/ }).waitFor({ timeout: 120000 });
  }
  await p.waitForFunction(() => !document.querySelector('[data-testid="approval-signoff"]')?.disabled, null, { timeout: 60000 });
  await shot(p, 'c6-checked', { clip: ['approval-check-result', 'approval-signoff'], pad: 16, marks: [{ t: 'approval-check-result', n: 1, at: 'tl' }, { t: 'approval-signoff', n: 2, at: 'tl' }] });
  await signoff.click();
  await tid(p, 'approval-confirm').waitFor({ timeout: 15000 });
  await shot(p, 'c6-send-confirm', { clip: 'approval-confirm', pad: 8, marks: [{ t: p.getByTestId('approval-confirm').getByRole('button', { name: /^Send .* for review$/ }), n: 3, at: 'tl' }] });
  await p.getByTestId('approval-confirm').getByRole('button', { name: /^Send .* for review$/ }).click();
  await p.getByTestId('approval-version-status').filter({ hasText: 'Under Review' }).waitFor({ timeout: 60000 });
  await p.waitForTimeout(1000);
  await shot(p, 'c6-under-review', { clip: 'full', marks: [{ t: 'approval-version-status', n: 1, at: 'tl' }, { t: 'approval-signoff', n: 2, at: 'tl' }] });
  await signoff.click();
  await tid(p, 'approval-confirm').waitFor({ timeout: 15000 });
  await shot(p, 'c6-approve-confirm', { clip: 'approval-confirm', pad: 8, marks: [{ t: p.getByTestId('approval-confirm').getByRole('button', { name: /^Approve / }), n: 3, at: 'tl' }] });
  await p.getByTestId('approval-confirm').getByRole('button', { name: /^Approve / }).click();
  await tid(p, 'approval-approved').waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
  await shot(p, 'c6-approved', { clip: 'approval-approved', pad: 16, marks: [{ t: 'approval-open-print', n: 1, at: 'tl', optional: true }] });
});

scene('audit', async () => {
  const p = await ensureDean();
  await go(p, 'audit-logs', 'Audit Trail');
  await p.waitForTimeout(2000);
  await shot(p, 'c6-audit', { clip: 'full' });
});

scene('print', async () => {
  const p = await ensureDean();
  await go(p, 'print-outputs', 'Print Outputs');
  await p.getByTestId('po-version-status').filter({ hasText: 'Approved' }).waitFor({ timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1200);
  await shot(p, 'c7-print-outputs', { clip: 'full', marks: [{ t: 'po-version-button', n: 1, at: 'tl' }, { t: 'po-card-export', n: 2, at: 'tl', highlight: false }] });
  const card = tid(p, 'po-card-export');
  await card.scrollIntoViewIfNeeded();
  await tid(p, 'export-view-button').click();
  await p.waitForTimeout(400);
  await shot(p, 'c7-export-forms', { clip: [card, 'export-view-list'], pad: 10, marks: [{ t: 'export-view-button', n: 1, at: 'tl' }] });
  await p.keyboard.press('Escape');
  await p.getByTestId('export-view').selectOption('teachers-program');
  await p.waitForTimeout(500);
  await tid(p, 'export-scope-button').click();
  await p.waitForTimeout(400);
  await shot(p, 'c7-export-scope', { clip: [card, 'export-scope-list'], pad: 10, marks: [{ t: 'export-scope-button', n: 2, at: 'tl' }] });
  await p.keyboard.press('Escape');
  const firstProf = await p.locator('[data-testid="export-scope"] option').nth(1).getAttribute('value');
  await p.getByTestId('export-scope').selectOption(firstProf);
  await p.waitForTimeout(400);
  const dl = p.waitForEvent('download', { timeout: 240000 });
  await tid(p, 'export-pdf').click();
  const file = await dl;
  const tmp = path.join(L.REPO, '.deploy-out', 'manual-shots', 'downloads');
  fs.mkdirSync(tmp, { recursive: true });
  await file.saveAs(path.join(tmp, file.suggestedFilename()));
  await p.getByTestId('export-status').filter({ hasText: /Downloaded/ }).waitFor({ timeout: 240000 }).catch(() => {});
  await shot(p, 'c7-export-done', { clip: card, pad: 10, marks: [{ t: 'export-docx', n: 3, at: 'tl' }, { t: 'export-pdf', n: 4, at: 'tl' }, { t: 'export-status', n: 5, at: 'tl', optional: true }] });
  // Word as well, and the whole Room Schedule.
  const dl2 = p.waitForEvent('download', { timeout: 240000 });
  await tid(p, 'export-docx').click();
  await (await dl2).saveAs(path.join(tmp, 'teachers-program.docx'));
  await p.getByTestId('export-view').selectOption('room-schedule');
  await p.waitForTimeout(500);
  const dl3 = p.waitForEvent('download', { timeout: 300000 });
  await tid(p, 'export-pdf').click();
  await (await dl3).saveAs(path.join(tmp, 'room-schedule.pdf'));
  await p.getByTestId('export-view').selectOption('class-schedule');
  await p.waitForTimeout(500);
  const dl4 = p.waitForEvent('download', { timeout: 300000 });
  await tid(p, 'export-pdf').click();
  await (await dl4).saveAs(path.join(tmp, 'class-schedule.pdf'));
  // The print view of each form (the same pages as the PDF), names blurred.
  for (const [form, testId, name] of [['teachers-program', 'print-professor-one', 'c7-form-teachers-program'], ['mother-schedule', 'print-section-one', 'c7-form-class-schedule'], ['room-program', 'print-room-one', 'c7-form-room-schedule']]) {
    await soft(name, async () => {
      const btn = tid(p, testId);
      await btn.scrollIntoViewIfNeeded();
      if (form === 'teachers-program') await shot(p, 'c7-print-buttons', { clip: btn, pad: 60, marks: [{ t: btn, n: 1, at: 'tl' }] });
      const popup = p.context().waitForEvent('page', { timeout: 30000 });
      await btn.click();
      const view = await popup;
      await view.setViewportSize({ width: 1366, height: 768 });
      await view.waitForSelector('.sheet, [data-testid^="print-sheet"]', { timeout: 120000 }).catch(() => {});
      await view.waitForTimeout(2500);
      const sheet = view.locator('.sheet, [data-testid^="print-sheet"]').first();
      await view.evaluate(() => window.scrollTo(0, 0));
      await shot(view, name, { clip: 'full' });
      await view.close();
    });
  }
});

scene('output-settings', async () => {
  const p = await ensureDean();
  await go(p, 'output-settings', 'Output Settings');
  await shot(p, 'c7-output-settings', { clip: 'full', marks: [{ t: 'os-all-collegeName', n: 1, at: 'tl' }, { t: 'os-submit', n: 2, at: 'tl' }] });
  const card = tid(p, 'os-card-teachersProgram');
  await tid(p, 'os-teachersProgram-sig-row-0').scrollIntoViewIfNeeded();
  await shot(p, 'c7-signatories', { clip: ['os-teachersProgram-sig-row-0', 'os-teachersProgram-sig-add'], pad: 14, marks: [{ t: 'os-teachersProgram-sig-label-0', n: 1, at: 'tl' }, { t: 'os-teachersProgram-sig-name-0', n: 2, at: 'tl' }, { t: 'os-teachersProgram-sig-title-0', n: 3, at: 'tl' }, { t: 'os-teachersProgram-sig-add', n: 4, at: 'tl' }] });
  void card;
  // "Show evaluation ratings on screen": on for the office, off for a presentation. Turned on, saved, and
  // turned off again (the practice copy holds no ratings).
  const screen = tid(p, 'os-card-screen');
  await screen.scrollIntoViewIfNeeded();
  await shot(p, 'c7-ratings-switch', { clip: screen, pad: 10, marks: [{ t: 'os-all-showEvaluationRatings', n: 1, at: 'tl' }] });
  for (let i = 0; i < 2; i++) {
    await p.getByTestId('os-all-showEvaluationRatings').click({ force: true }).catch(async () => { await screen.getByRole('switch').first().click(); });
    await p.waitForTimeout(400);
    await tid(p, 'os-submit').click();
    await p.waitForTimeout(2000);
    if (i === 0) await soft('saved', () => shot(p, 'c7-output-saved', { clip: 'os-status', pad: 12, marks: [{ t: 'os-status', n: 2, at: 'tl' }] }));
  }
});
