// Phase 15: the Office Manual's scenes after sign-in, in the order they are done on the practice copy.
// Each scene really does the step it pictures. The image names start with the manual's chapter (c2-…).
const fs = require('fs');
const path = require('path');
const { scene, shot, go, tid, choose, dump, newPage, signIn, ctx, state, L, newPassword, S, deanCreds, SHOTS_ROOT } = require('./shoot');

const modal = (p) => p.locator('[role="dialog"], [role="alertdialog"], .fixed.inset-0 > div').filter({ visible: true }).last();
const ensureDean = async () => {
  if (S.dean && !S.dean.isClosed()) return S.dean;
  S.dean = await newPage();
  await signIn(S.dean, deanCreds().email, deanCreds().password);
  return S.dean;
};

scene('tour', async () => {
  const p = await ensureDean();
  await go(p, 'checklist', 'Term Checklist');
  await shot(p, 'c2-tour', {
    clip: 'full',
    marks: [
      { t: 'nav-group-setup', n: 1, at: 'tr', highlight: false },
      { t: 'nav-collapse', n: 2, at: 'r' },
      { t: 'topbar-page-name', n: 3, at: 'bl', highlight: false },
      { t: 'page-search', n: 4, at: 'bl', highlight: false },
      { t: 'term-year-button', n: 5, at: 'bl', highlight: false },
      { t: 'term-semester-button', n: 6, at: 'br', highlight: false },
      { t: p.getByRole('button', { name: /Switch to (dark|light) mode/ }), n: 7, at: 'bl', highlight: false },
      { t: 'notif-toggle', n: 8, at: 'bl', highlight: false },
      { t: 'topbar-user', n: 9, at: 'bl', highlight: false },
      { t: 'page-title', n: 10, at: 'tl', highlight: false },
      { t: 'nav-user', n: 11, at: 'tr', highlight: false },
      { t: p.getByRole('button', { name: 'Sign Out' }), n: 12, at: 'tr', highlight: false }
    ]
  });
  // The checklist's steps and the warnings, cropped.
  await shot(p, 'c3-checklist-top', { clip: ['backup-warnings', 'checklist-step-1'], marks: [{ t: 'backup-warnings', n: 1, at: 'tl' }, { t: 'checklist-summary', n: 2, at: 'tl' }, { t: 'checklist-step-1-status', n: 3, at: 'r' }, { t: 'checklist-link-subjects', n: 4, at: 'r' }] });
  await p.getByTestId('checklist-step-4').scrollIntoViewIfNeeded();
  await shot(p, 'c3-checklist-steps', { clip: ['checklist-step-3', 'checklist-step-6'], pad: 16, marks: [{ t: 'readiness-fix-9', n: 1, at: 'r' }, { t: 'checklist-step-4-status', n: 2, at: 'r' }, { t: 'checklist-link-generate', n: 3, at: 'r' }] });
});

scene('sidebar', async () => {
  const p = await ensureDean();
  await go(p, 'checklist', 'Term Checklist');
  await shot(p, 'c2-collapse', { clip: { x: 0, y: 0, width: 640, height: 230 }, marks: [{ t: 'nav-collapse', n: 1, arrow: 'down', arrowLength: 50 }] });
  await tid(p, 'nav-collapse').click();
  await p.waitForTimeout(900);
  await tid(p, 'nav-faculty').hover().catch(async () => { await tid(p, 'nav-group-setup').hover(); });
  await p.waitForTimeout(500);
  await shot(p, 'c2-collapsed', { clip: { x: 0, y: 0, width: 520, height: 560 }, marks: [{ t: 'nav-collapse', n: 2 }] });
  await tid(p, 'nav-collapse').click();
  await p.waitForTimeout(900);
  // A menu group opens and closes with a click.
  await tid(p, 'nav-group-admin').click();
  await p.waitForTimeout(500);
  await shot(p, 'c2-menu-group', { clip: ['nav-group-admin', 'nav-system'], padX: 20, padY: 16, marks: [{ t: 'nav-group-admin', n: 1, at: 'r' }, { t: 'nav-system', n: 2, at: 'r' }] });
  await tid(p, 'nav-group-admin').click();
});

scene('term-picker', async () => {
  const p = await ensureDean();
  await go(p, 'checklist', 'Term Checklist');
  await tid(p, 'term-year-button').click();
  await p.waitForTimeout(500);
  await shot(p, 'c2-term-year', { clip: ['term-year-button', 'term-year-list'], pad: 24, marks: [{ t: 'term-year-button', n: 1, at: 'tl' }, { t: p.locator('[data-testid="term-year-list"] [role="option"]').filter({ hasText: '(current)' }), n: 2, at: 'tl' }] });
  await p.keyboard.press('Escape');
  await tid(p, 'term-semester-button').click();
  await p.waitForTimeout(500);
  await shot(p, 'c2-term-semester', { clip: ['term-semester-button', 'term-semester-list'], pad: 24, marks: [{ t: 'term-semester-button', n: 3, at: 'tl' }] });
  await p.keyboard.press('Escape');
  // The header search.
  await tid(p, 'page-search').fill('Fac');
  await p.waitForTimeout(600);
  await shot(p, 'c2-search', { clip: ['page-search', 'page-search-results'], pad: 20, marks: [{ t: 'page-search', n: 1, at: 'tl' }, { t: 'page-search-faculty', n: 2, at: 'tl' }] });
  await tid(p, 'page-search').fill('');
  await p.keyboard.press('Escape');
});

// Chapter 8 first: the Dean renames the practice account (so the pictures read "PRACTICE Dean"), adds the
// College Secretary, tries to give away the last Dean role, and locks and reactivates the new account.
const userRow = (p, name) => p.locator('tr').filter({ hasText: name }).first();
const openUserMenu = async (p, name) => {
  await userRow(p, name).locator('[data-testid^="users-actions-"]').click();
  await p.waitForTimeout(300);
};
scene('accounts', async () => {
  const p = await ensureDean();
  await go(p, 'users-roles', 'Users & Roles');
  const deanRowName = (await p.locator('tr').filter({ has: p.locator('[data-testid^="users-actions-"]') }).first().innerText()).includes('PRACTICE Dean') ? 'PRACTICE Dean' : 'TEST Dean';
  await openUserMenu(p, deanRowName);
  await shot(p, 'c8-actions-menu', { clip: [userRow(p, deanRowName), p.locator('[data-testid^="users-edit-"]').first()], pad: 18, marks: [{ t: userRow(p, deanRowName).locator('[data-testid^="users-actions-"]'), n: 1, at: 'tl' }, { t: p.locator('[data-testid^="users-edit-"]').first(), n: 2, at: 'tl' }] });
  await p.locator('[data-testid^="users-edit-"]').first().click();
  await tid(p, 'user-name').waitFor();
  await tid(p, 'user-name').fill('PRACTICE Dean');
  await tid(p, 'user-title').fill('Dean, College of Computer Studies');
  const dialog = modal(p);
  await shot(p, 'c8-edit-own', { clip: dialog, pad: 10, marks: [{ t: 'user-name', n: 3, at: 'tl' }, { t: 'user-email', n: 4, at: 'tl' }, { t: 'user-title', n: 5, at: 'tl' }, { t: 'user-password', n: 6, at: 'tl' }, { t: 'user-submit', n: 7, at: 'tr' }] });
  // The last Dean can't be given another role.
  await choose(p, 'user-role', 'College Secretary');
  await tid(p, 'user-submit').click();
  await tid(p, 'user-form-error').waitFor({ timeout: 15000 });
  await shot(p, 'c8-last-dean', { clip: ['user-form-error', 'user-email'], pad: 16, marks: [{ t: 'user-form-error', n: 1, at: 'tl' }] });
  await choose(p, 'user-role', 'Dean');
  await tid(p, 'user-submit').click();
  await tid(p, 'users-toast').waitFor({ timeout: 15000 });
  await shot(p, 'c8-saved', { clip: 'users-toast', pad: 12 });
  await p.waitForTimeout(800);

  // Add the College Secretary.
  if (!state.secretary) state.secretary = { email: 'secretary.practice@example.test', password: newPassword() };
  L.writeState(state);
  await go(p, 'users-roles', 'Users & Roles');
  const exists = await p.locator('tr').filter({ hasText: 'PRACTICE College Secretary' }).count();
  if (!exists) {
    await tid(p, 'users-add').click();
    await tid(p, 'user-name').waitFor();
    await tid(p, 'user-name').fill('PRACTICE College Secretary');
    await tid(p, 'user-email').fill(state.secretary.email);
    await tid(p, 'user-title').fill('College Secretary');
    await tid(p, 'user-password').fill(state.secretary.password);
    await choose(p, 'user-role', 'College Secretary');
    await p.waitForTimeout(400);
    const d = modal(p);
    await shot(p, 'c8-add-user', { clip: d, pad: 10, marks: [{ t: 'user-name', n: 2, at: 'tl' }, { t: 'user-email', n: 3, at: 'tl' }, { t: 'user-title', n: 4, at: 'tl' }, { t: 'user-password', n: 5, at: 'tl' }, { t: 'user-role-button', n: 6, at: 'tl' }, { t: 'user-submit', n: 7, at: 'tl' }] });
    await tid(p, 'user-submit').click();
    await tid(p, 'users-toast').waitFor({ timeout: 15000 });
    await p.waitForTimeout(800);
  }
  await go(p, 'users-roles', 'Users & Roles');
  await shot(p, 'c8-users-list', { clip: p.locator('table').first(), pad: 16, marks: [{ t: 'users-add', n: 1, at: 'tl' }, { t: userRow(p, 'PRACTICE College Secretary'), n: 8, at: 'l', highlight: false }] , padY: 70 });
  S.refreshNames = true;

  // Lock the new account, then reactivate it.
  await openUserMenu(p, 'PRACTICE College Secretary');
  const lockBtn = p.locator('[data-testid^="users-lock-"]').filter({ visible: true }).first();
  await shot(p, 'c8-lock', { clip: [userRow(p, 'PRACTICE College Secretary'), lockBtn], pad: 18, marks: [{ t: lockBtn, n: 2, at: 'tl' }] });
  await lockBtn.click();
  await p.waitForTimeout(1500);
  const confirm = p.getByRole('alertdialog');
  if (await confirm.count()) { await shot(p, 'c8-lock-confirm', { clip: confirm.first(), pad: 10 }); await confirm.getByRole('button').filter({ hasText: /Lock/ }).first().click(); await p.waitForTimeout(1500); }
  await shot(p, 'c8-locked', { clip: userRow(p, 'PRACTICE College Secretary'), pad: 14, marks: [{ t: userRow(p, 'PRACTICE College Secretary').getByText('Locked', { exact: false }).first(), n: 3, at: 'tl' }] });
  await openUserMenu(p, 'PRACTICE College Secretary');
  await p.locator('[data-testid^="users-lock-"]').filter({ visible: true }).first().click();
  await p.waitForTimeout(1500);
  if (await p.getByRole('alertdialog').count()) { await p.getByRole('alertdialog').getByRole('button').last().click(); await p.waitForTimeout(1500); }
  // Sign in again, so every later picture shows the new name in the side menu.
  await p.context().close();
  S.dean = null;
});

// The first sign-in: the practice copy's College Secretary gets a starting password (the flag the office
// kit's reset-password sets), then signs in and changes it.
scene('starting-password', async () => {
  const { MongoClient } = require(path.join(L.REPO, 'server', 'node_modules', 'mongodb'));
  const client = new MongoClient(ctx.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const r = await client.db().collection('users').updateOne({ email: state.secretary.email }, { $set: { mustChangePassword: true } });
    if (!r.matchedCount) throw new Error('No PRACTICE College Secretary account: run the accounts scene first.');
  } finally { await client.close(); }
  const p = await newPage();
  await signIn(p, state.secretary.email, state.secretary.password, { expectHome: false });
  await tid(p, 'starting-password-page').waitFor({ timeout: 30000 });
  await p.waitForTimeout(600);
  const next = newPassword();
  await tid(p, 'starting-current').fill(state.secretary.password);
  await tid(p, 'starting-next').fill(next);
  await tid(p, 'starting-confirm').fill(next);
  await shot(p, 'c2-starting-password', { clip: 'full', marks: [{ t: 'starting-current', n: 1, at: 'tl' }, { t: 'starting-next', n: 2, at: 'tl' }, { t: 'starting-confirm', n: 3, at: 'tl' }, { t: 'starting-submit', n: 4, at: 'tl' }] });
  await tid(p, 'starting-submit').click();
  await p.getByTestId('nav-group-setup').waitFor({ timeout: 30000 });
  state.secretary.password = next;
  L.writeState(state);
  await p.waitForTimeout(1200);
  await shot(p, 'c2-secretary-home', { clip: { x: 0, y: 0, width: 1366, height: 768 }, marks: [{ t: 'nav-console', n: 1, at: 'r' }, { t: 'nav-user', n: 2, at: 'tr' }] });
  // Signing out.
  await shot(p, 'c2-sign-out', { clip: ['nav-user', p.getByRole('button', { name: 'Sign Out' })], pad: 16, marks: [{ t: p.getByRole('button', { name: 'Sign Out' }), n: 1, at: 'tr' }] });
  await p.getByRole('button', { name: 'Sign Out' }).click();
  await p.getByTestId('login-submit').waitFor({ timeout: 20000 });
  await p.context().close();
});

const soft = async (name, fn) => { try { await fn(); } catch (e) { console.error('  (skipped ' + name + ': ' + e.message.split(/\r?\n/)[0] + ')'); if (S.dean) await dump(S.dean, 'soft-' + name); } };
const waitToast = async (p, id) => { await p.getByTestId(id).first().waitFor({ timeout: 15000 }).catch(() => {}); };
module.exports = { modal, ensureDean, soft, waitToast, userRow };
require('./scenes-setup');
require('./scenes-assign');
require('./scenes-schedule');
require('./scenes-system');

// The order the scenes are done in (the accounts first, so every later picture reads "PRACTICE Dean").
const { SCENES } = require('./shoot');
const ORDER = ['signin', 'accounts', 'starting-password', 'tour', 'sidebar', 'term-picker', 'calendar', 'rooms', 'sections', 'subjects', 'faculty', 'policy', 'by-class', 'loads', 'recommendations', 'readiness', 'generate', 'views', 'move', 'swap-and-professor', 'versions', 'approval', 'audit', 'print', 'output-settings', 'backup', 'backup-password', 'second-folder', 'restore', 'closed', 'conflicts-example', 'glossary'];
SCENES.sort((a, b) => (ORDER.indexOf(a.id) + 1 || 999) - (ORDER.indexOf(b.id) + 1 || 999));
