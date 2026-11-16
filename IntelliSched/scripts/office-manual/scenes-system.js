// Phase 15, chapters 9-11: backups (Back up now, the second folder, the backup password, a restore), closing
// when unused, and the page a closed IntelliSched leaves. The "USB stick" is a folder under
// .deploy-out/manual-shots/ (removed afterwards); the restore is done on the practice copy itself.
const fs = require('fs');
const path = require('path');
const { scene, shot, go, tid, choose, newPage, signIn, state, L, newPassword, S, deanCreds, SHOTS_ROOT } = require('./shoot');
const { ensureDean, soft } = require('./scenes');

const USB = path.join(SHOTS_ROOT, 'USB stick (E)', 'IntelliSched Backups');
const newestFull = (p) => p.locator('[data-testid^="system-file-IntelliSched-backup_"]').first();
const backUpNow = async (p) => {
  const before = await tid(p, 'system-last-backup').innerText().catch(() => '');
  await tid(p, 'system-backup-now').click();
  await p.waitForFunction((b) => { const el = document.querySelector('[data-testid="system-last-backup"]'); return el && el.innerText !== b && !/running|making/i.test(el.innerText); }, before, { timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(2500);
};

scene('backup', async () => {
  const p = await ensureDean();
  await go(p, 'system', 'System');
  await shot(p, 'c9-system', { clip: 'full', marks: [{ t: 'system-backup-now', n: 1, at: 'tl' }, { t: 'system-warnings', n: 2, at: 'tl', optional: true }] });
  await backUpNow(p);
  await shot(p, 'c9-backed-up', { clip: ['system-last-backup', 'system-files'], pad: 14, marks: [{ t: 'system-last-backup', n: 1, at: 'tl' }, { t: newestFull(p), n: 2, at: 'tl' }] });
  await tid(p, 'system-folder').scrollIntoViewIfNeeded();
  await shot(p, 'c9-settings', { clip: ['system-folder', 'system-settings-save'], pad: 20, marks: [{ t: 'system-folder', n: 1, at: 'tl' }, { t: 'system-second-folder', n: 2, at: 'tl' }, { t: 'system-daily', n: 3, at: 'tl', optional: true }, { t: 'system-keep', n: 4, at: 'tl', optional: true }, { t: 'system-idle-button', n: 5, at: 'tl' }, { t: 'system-settings-save', n: 6, at: 'tl' }] });
  // Close when unused: the choices.
  await tid(p, 'system-idle-button').click();
  await p.waitForTimeout(400);
  await shot(p, 'c10-close-when-unused', { clip: ['system-idle-button', 'system-idle-list'], pad: 16, marks: [{ t: 'system-idle-button', n: 1, at: 'tl' }] });
  await p.keyboard.press('Escape');
});

scene('backup-password', async () => {
  const p = await ensureDean();
  await go(p, 'system', 'System');
  if (!state.backupPassword) state.backupPassword = newPassword();
  L.writeState(state);
  await tid(p, 'system-password-form').scrollIntoViewIfNeeded();
  await tid(p, 'system-pw-loginPassword').fill(deanCreds().password);
  await tid(p, 'system-pw-next').fill(state.backupPassword);
  await tid(p, 'system-pw-confirm').fill(state.backupPassword);
  await shot(p, 'c9-backup-password', { clip: 'system-password-form', pad: 14, marks: [{ t: 'system-pw-loginPassword', n: 1, at: 'tl' }, { t: 'system-pw-next', n: 2, at: 'tl' }, { t: 'system-pw-confirm', n: 3, at: 'tl' }, { t: 'system-pw-save', n: 4, at: 'tl' }] });
  await tid(p, 'system-pw-save').click();
  await p.waitForTimeout(2500);
  state.backupPasswordSet = true;
  L.writeState(state);
  await soft('pw-changed', () => shot(p, 'c9-backup-password-done', { clip: 'system-password-form', pad: 14, marks: [{ t: 'system-password-state', n: 5, at: 'tl' }] }));
});

scene('second-folder', async () => {
  const p = await ensureDean();
  fs.mkdirSync(USB, { recursive: true });
  await go(p, 'system', 'System');
  await tid(p, 'system-second-folder').scrollIntoViewIfNeeded();
  await tid(p, 'system-second-folder').fill(USB);
  await tid(p, 'system-settings-save').click();
  await p.waitForTimeout(2500);
  await shot(p, 'c9-second-folder', { clip: ['system-second-folder', 'system-settings-save'], pad: 20, marks: [{ t: 'system-second-folder', n: 1, at: 'tl' }, { t: 'system-second-folder-state', n: 2, at: 'tl', optional: true }, { t: 'system-settings-save', n: 3, at: 'tl' }] });
  await backUpNow(p);
  const copied = fs.readdirSync(USB);
  console.log(`  the "USB stick" holds ${copied.length} file(s) after Back up now`);
  if (!copied.some(f => f.endsWith('.isbak'))) throw new Error('The second folder got no backup.');
  // The stick is pulled out: the next backup still works and the page says so.
  fs.rmSync(path.join(SHOTS_ROOT, 'USB stick (E)'), { recursive: true, force: true });
  await backUpNow(p);
  await go(p, 'system', 'System');
  await soft('second-missing', () => shot(p, 'c11-second-folder-missing', { clip: 'system-warnings', pad: 14, marks: [{ t: 'system-warning-SECOND_FOLDER', n: 1, at: 'tl' }] }));
  await go(p, 'checklist', 'Term Checklist');
  await soft('checklist-warning', () => shot(p, 'c9-checklist-warning', { clip: 'backup-warnings', pad: 14, marks: [{ t: 'backup-warning-fix-SECOND_FOLDER', n: 1, at: 'tl', optional: true }] }));
  // The stick back in: the folder exists again and the next backup catches up.
  fs.mkdirSync(USB, { recursive: true });
  await go(p, 'system', 'System');
  await backUpNow(p);
  console.log(`  the "USB stick" holds ${fs.readdirSync(USB).length} file(s) again`);
});

scene('restore', async () => {
  const p = await ensureDean();
  await go(p, 'system', 'System');
  const row = newestFull(p);
  await row.scrollIntoViewIfNeeded();
  const restoreBtn = row.locator('[data-testid^="system-file-restore-"]');
  await shot(p, 'c9-restore-start', { clip: 'system-files', pad: 14, marks: [{ t: restoreBtn, n: 1, at: 'tl' }] });
  await restoreBtn.click();
  await tid(p, 'system-restore-panel').waitFor({ timeout: 20000 });
  await tid(p, 'system-restore-password').fill(state.backupPassword);
  await shot(p, 'c9-restore-password', { clip: 'system-restore-panel', pad: 10, marks: [{ t: 'system-restore-password', n: 2, at: 'tl' }, { t: 'system-restore-check', n: 3, at: 'tl' }] });
  await tid(p, 'system-restore-check').click();
  await tid(p, 'system-restore-confirm').waitFor({ timeout: 60000 });
  await tid(p, 'system-restore-confirm').fill('RESTORE');
  await p.waitForTimeout(400);
  await shot(p, 'c9-restore-confirm', { clip: 'system-restore-panel', pad: 10, marks: [{ t: 'system-restore-summary', n: 4, at: 'tl', optional: true }, { t: 'system-restore-confirm', n: 5, at: 'tl' }, { t: 'system-restore-go', n: 6, at: 'tl' }] });
  await tid(p, 'system-restore-go').click();
  await p.locator('[data-testid="system-restored"], [data-testid="system-sign-in-again"], [data-testid="login-submit"]').first().waitFor({ timeout: 300000 });
  await p.waitForTimeout(1500);
  await soft('restored', () => shot(p, 'c9-restored', { clip: p.locator('[data-testid="system-restored"], [data-testid="system-sign-in-again"]').first(), pad: 16, marks: [{ t: 'system-sign-in-again', n: 7, at: 'tl', optional: true }] }));
  await p.context().close();
  S.dean = null;
});

scene('closed', async () => {
  const p = await newPage();
  await signIn(p, deanCreds().email, deanCreds().password);
  await p.waitForTimeout(1500);
  // IntelliSched stops answering (as when it closed itself): every request fails from now on.
  await p.route('**/api/**', (route) => route.abort('connectionrefused'));
  await p.getByTestId('app-closed').waitFor({ timeout: 60000 });
  await p.waitForTimeout(500);
  await shot(p, 'c10-closed-page', { clip: p.getByTestId('app-closed').locator('div').first(), pad: 30 });
  await p.context().close();
});

// A real example of conflicts for chapter 5: AVR is switched off after the schedule was made, the whole
// schedule is checked (its classes now sit in a room that can't be used), and AVR is switched on again.
scene('conflicts-example', async () => {
  const p = await ensureDean();
  await go(p, 'rooms', 'Rooms');
  const row = p.locator('tr').filter({ hasText: 'AVR' }).first();
  const toggle = async (word) => {
    const btn = row.getByRole('button', { name: `${word} AVR` });
    if (!(await btn.count())) return;
    await btn.click();
    await p.waitForTimeout(1000);
    const dlg = p.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true });
    if (await dlg.count()) await dlg.last().getByRole('button', { name: new RegExp(word) }).last().click().catch(() => {});
    await p.waitForTimeout(1500);
  };
  await toggle('Disable');
  try {
    await go(p, 'schedule-views', 'Schedule Views & Editor');
    await tid(p, 'views-check-all').click();
    await tid(p, 'views-check-result').waitFor({ timeout: 120000 });
    await p.waitForTimeout(1000);
    await shot(p, 'c5-conflicts-list', { clip: 'views-check-result', pad: 14, marks: [{ t: 'views-check-result', n: 1, at: 'tl', highlight: false }] });
  } finally {
    await go(p, 'rooms', 'Rooms');
    await toggle('Enable');
  }
});

// Small pictures for "Words to know" (no markers): each one is one element of the real screen.
scene('glossary', async () => {
  const p = await ensureDean();
  const g = (name, target, pad = 8) => soft(name, () => shot(p, name, { clip: target, pad, scrollTo: target }));
  await go(p, 'checklist', 'Term Checklist');
  await g('g-term', 'current-term');
  await go(p, 'approval', 'Approval');
  await g('g-approved', 'approval-version-status', 10);
  await go(p, 'readiness', 'Readiness Check');
  await p.getByTestId('readiness-verdict').waitFor({ timeout: 120000 });
  await g('g-readiness', 'readiness-verdict-label', 10);
  await go(p, 'faculty', 'Faculty');
  await g('g-load', 'faculty-load-FAC-001', 10);
  await go(p, 'schedule-views', 'Schedule Views & Editor');
  await tid(p, 'views-tab-section').click();
  await p.waitForTimeout(1500);
  const tbaBlock = p.locator('[data-testid^="views-block-"]').filter({ hasText: /TBA/ }).first();
  await g('g-tba', tbaBlock, 6);
  const majorBlock = p.locator('[data-testid^="views-block-"]').filter({ hasText: /\(PTF\)|\(Assoc|Instructor|Prof/ }).first();
  await g('g-class-box', majorBlock, 6);
  await go(p, 'system', 'System');
  await g('g-backup', 'system-backup-now', 10);
  await g('g-backup-file', p.locator('[data-testid^="system-file-IntelliSched-backup_"]').first(), 4);
});
