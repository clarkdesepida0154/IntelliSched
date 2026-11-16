// Phase 15, chapter 3: getting a term ready (the academic calendar, rooms, sections, subjects, faculty, policy).
const { scene, shot, go, tid, choose } = require('./shoot');
const { modal, ensureDean, soft, waitToast } = require('./scenes');

scene('calendar', async () => {
  const p = await ensureDean();
  await go(p, 'system', 'System');
  await tid(p, 'system-calendar').scrollIntoViewIfNeeded();
  await shot(p, 'c3-calendar', { clip: 'system-calendar', pad: 12, marks: [{ t: 'system-cal-yearStart-month-button', n: 1, at: 'tl' }, { t: 'system-cal-yearStart-day-button', n: 2, at: 'tl' }, { t: 'system-cal-secondSemesterStart-month-button', n: 3, at: 'tl' }, { t: 'system-calendar-save', n: 4, at: 'tl' }, { t: 'system-calendar-current', n: 5, at: 'tl', highlight: false }] });
  // Save it as it is (June 1 and November 1, the defaults): the step works and changes nothing.
  await choose(p, 'system-cal-yearStart-month', '6');
  if (await tid(p, 'system-calendar-save').isEnabled()) {
    await tid(p, 'system-calendar-save').click();
    await p.waitForTimeout(1500);
  }
});

scene('rooms', async () => {
  const p = await ensureDean();
  await go(p, 'rooms', 'Rooms');
  await shot(p, 'c3-rooms', { clip: p.locator('main table').first(), pad: 16, padY: 80, marks: [{ t: 'room-add', n: 1, at: 'tl' }, { t: 'room-search', n: 2, at: 'tl' }] });
  const has = await p.locator('tr').filter({ hasText: 'ROOM 48' }).count();
  if (!has) {
    await tid(p, 'room-add').click();
    await tid(p, 'room-name').waitFor();
    await tid(p, 'room-name').fill('ROOM 48');
    await choose(p, 'room-type', 'LEC');
    await tid(p, 'room-capacity').fill('40');
    await tid(p, 'room-building').fill('CCS Building');
    await p.waitForTimeout(400);
    await shot(p, 'c3-room-form', { clip: modal(p), pad: 8, marks: [{ t: 'room-name', n: 2, at: 'tl' }, { t: 'room-type-button', n: 3, at: 'tl' }, { t: 'room-capacity', n: 4, at: 'tl' }, { t: 'room-submit', n: 5, at: 'tl' }] });
    await tid(p, 'room-submit').click();
    await p.waitForTimeout(1500);
  }
  // Rooms not used this term are disabled, not deleted: the practice room is switched off again.
  const row = p.locator('tr').filter({ hasText: 'ROOM 48' }).first();
  await shot(p, 'c3-room-added', { clip: row, pad: 12, marks: [{ t: row.getByRole('button', { name: 'Edit ROOM 48' }), n: 1, at: 'tl' }, { t: row.getByRole('button', { name: /^(Disable|Enable) ROOM 48$/ }), n: 2, at: 'tr' }] });
  const disable = row.getByRole('button', { name: 'Disable ROOM 48' });
  if (await disable.count()) {
    await disable.click();
    await p.waitForTimeout(1000);
    const dlg = p.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true });
    if (await dlg.count()) await dlg.last().getByRole('button', { name: /Disable/ }).last().click().catch(() => {});
    await p.waitForTimeout(1500);
  }
  if (!(await row.getByRole('button', { name: 'Enable ROOM 48' }).count())) throw new Error('ROOM 48 is still active.');
});

scene('sections', async () => {
  const p = await ensureDean();
  await go(p, 'sections', 'Sections');
  await shot(p, 'c3-sections', { clip: p.locator('main table').first(), pad: 16, padY: 80, marks: [{ t: 'section-add', n: 1, at: 'tl' }, { t: p.locator('tr').filter({ hasText: 'BSCS 2B' }).getByText('Disabled'), n: 2, at: 'tl' }] });
  await p.getByRole('button', { name: 'Edit BSIT 1A' }).click();
  await tid(p, 'section-code').waitFor();
  await tid(p, 'section-student-count').fill('40');
  await p.waitForTimeout(300);
  await shot(p, 'c3-section-form', { clip: modal(p), pad: 8, marks: [{ t: 'section-code', n: 2, at: 'tl' }, { t: 'section-program-button', n: 3, at: 'tl' }, { t: 'section-year-button', n: 4, at: 'tl' }, { t: 'section-track-button', n: 5, at: 'tl', optional: true }, { t: 'section-student-count', n: 6, at: 'tl' }, { t: 'section-submit', n: 7, at: 'tl' }] });
  await tid(p, 'section-submit').click();
  await waitToast(p, 'section-toast');
  await soft('section-saved', () => shot(p, 'c3-section-saved', { clip: 'section-toast', pad: 10 }));
});

scene('subjects', async () => {
  const p = await ensureDean();
  await go(p, 'subjects', 'Curriculum & Subjects');
  await tid(p, 'catalog-search').fill('ITEC 103');
  await p.waitForTimeout(800);
  const tabs = p.getByRole('tab');
  await shot(p, 'c3-catalog', { clip: ['catalog-search', p.locator('main table').first()], pad: 16, marks: [{ t: tabs.first(), n: 1, at: 'tl' }, { t: 'catalog-search', n: 2, at: 'tl' }, { t: 'catalog-add', n: 3, at: 'tl' }, { t: p.getByRole('button', { name: /^Edit ITEC 103/ }).first(), n: 4, at: 'tl' }] });
  await p.getByRole('button', { name: /^Edit ITEC 103/ }).first().click();
  await tid(p, 'catalog-code').waitFor();
  await p.waitForTimeout(400);
  await shot(p, 'c3-subject-form', { clip: modal(p), pad: 8, marks: [{ t: 'catalog-code', n: 1, at: 'tl' }, { t: 'catalog-title', n: 2, at: 'tl' }, { t: 'catalog-type-button', n: 3, at: 'tl' }, { t: 'catalog-lectureMode-button', n: 4, at: 'tl' }, { t: 'catalog-submit', n: 5, at: 'tl' }] });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  if (await tid(p, 'catalog-code').count()) await modal(p).getByRole('button', { name: /Cancel/ }).first().click().catch(() => {});
  await tid(p, 'catalog-search').fill('');
  // The Curriculum Builder tab.
  await tabs.nth(1).click();
  await p.waitForTimeout(1500);
  await shot(p, 'c3-builder', { clip: 'full', marks: [{ t: tabs.nth(1), n: 1, at: 'tl' }, { t: 'builder-context', n: 2, at: 'tl' }, { t: 'builder-attach-open', n: 3, at: 'tl' }] });
});

scene('faculty', async () => {
  const p = await ensureDean();
  await go(p, 'faculty', 'Faculty');
  await shot(p, 'c3-faculty', { clip: { x: 270, y: 150, width: 1096, height: 618 }, marks: [{ t: 'faculty-add', n: 1, at: 'tl' }, { t: 'faculty-search', n: 2, at: 'tl' }, { t: 'faculty-load-FAC-001', n: 3, at: 'tl' }] });
  // Add a practice professor: full-time first, with the usual duties.
  const exists = await p.locator('tr').filter({ hasText: 'PRACTICE Professor' }).count();
  if (!exists) {
    await tid(p, 'faculty-add').click();
    await tid(p, 'faculty-name').waitFor();
    await tid(p, 'faculty-name').fill('PRACTICE Professor');
    await choose(p, 'faculty-employmentType', 'FULL_TIME');
    await p.waitForTimeout(400);
    await shot(p, 'c3-faculty-form-top', { clip: modal(p), pad: 0, marks: [{ t: 'faculty-name', n: 2, at: 'tl' }, { t: 'faculty-employmentType-button', n: 3, at: 'tl' }, { t: 'faculty-position', n: 4, at: 'tl' }, { t: 'faculty-degreeLevel-button', n: 5, at: 'tl' }] });
    await tid(p, 'faculty-teachingCapHours').scrollIntoViewIfNeeded();
    await shot(p, 'c3-faculty-form-load', { clip: modal(p), pad: 0, marks: [{ t: 'faculty-teachingCapHours', n: 6, at: 'tl' }, { t: 'faculty-minTeachingHours', n: 7, at: 'tl' }] });
    await soft('faculty-ancillary', async () => {
      await tid(p, 'faculty-ancillary-standard').click();
      await p.waitForTimeout(500);
      await shot(p, 'c3-faculty-ancillary', { clip: modal(p), pad: 0, scrollTo: 'faculty-ancillary-type-0', marks: [{ t: 'faculty-ancillary-type-0-button', n: 10, at: 'tl' }, { t: 'faculty-ancillary-hours-0', n: 11, at: 'tl' }, { t: 'faculty-ancillary-standard', n: 9, at: 'tl', optional: true }, { t: 'faculty-ancillary-add', n: null, at: 'tl' }] });
    });
    // Part-time: the ancillary fields are switched off.
    await choose(p, 'faculty-employmentType', 'PART_TIME');
    await p.waitForTimeout(500);
    await soft('faculty-part-time', () => shot(p, 'c3-faculty-part-time', { clip: modal(p), pad: 0, scrollTo: 'faculty-ancillary-part-time', marks: [{ t: 'faculty-ancillary-part-time', n: null, at: 'tl' }] }));
    await choose(p, 'faculty-employmentType', 'FULL_TIME');
    await p.waitForTimeout(300);
    // The Unavailable times grid.
    await soft('faculty-grid', async () => {
      const cell = p.getByRole('button', { name: /^Friday 1:00–1:30 PM/ }).first();
      await cell.scrollIntoViewIfNeeded();
      await cell.click();
      await p.getByRole('button', { name: /^Friday 1:30–2:00 PM/ }).first().click();
      await p.waitForTimeout(300);
      await shot(p, 'c3-faculty-unavailable', { clip: modal(p), pad: 0, scrollTo: cell, marks: [{ t: cell, n: 12, at: 'tl' }, { t: 'faculty-submit', n: 13, at: 'tl' }] });
    });
    // At least one specialization is required.
    await soft('faculty-specializations', async () => {
      const box = tid(p, 'faculty-specializations');
      await box.scrollIntoViewIfNeeded();
      await box.locator('[role="combobox"]').click();
      await p.waitForTimeout(300);
      await shot(p, 'c3-faculty-specializations-open', { clip: modal(p), pad: 0, scrollTo: box, marks: [{ t: box.locator('[role="combobox"]'), n: 8, at: 'tl' }] });
      await box.locator('[role="option"]').first().click();
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
      await shot(p, 'c3-faculty-specializations', { clip: modal(p), pad: 0, scrollTo: box, marks: [{ t: box, n: 8, at: 'tl', highlight: false }] });
    });
    await tid(p, 'faculty-submit').scrollIntoViewIfNeeded();
    await tid(p, 'faculty-submit').click();
    await p.waitForTimeout(2000);
  }
  // Archive the practice professor again (out of the term's lists, kept in the records).
  await go(p, 'faculty', 'Faculty');
  await tid(p, 'faculty-search').fill('PRACTICE');
  await p.waitForTimeout(800);
  const row = p.locator('tr').filter({ hasText: 'PRACTICE Professor' }).first();
  await soft('faculty-row', () => shot(p, 'c3-faculty-row', { clip: row, pad: 12, marks: [{ t: row.getByRole('button', { name: 'Edit PRACTICE Professor' }), n: 1, at: 'tl' }, { t: row.locator('[data-testid^="faculty-archive-"]'), n: 2, at: 'tl' }] }));
  const archive = row.locator('[data-testid^="faculty-archive-"]');
  if (await archive.count()) {
    await archive.click();
    await p.waitForTimeout(800);
    await soft('faculty-archive-confirm', () => shot(p, 'c3-faculty-archive', { clip: modal(p), pad: 8 }));
    await modal(p).getByRole('button', { name: /^Archive/ }).last().click().catch(() => {});
    await p.waitForTimeout(1500);
  }
  await tid(p, 'faculty-search').fill('');
});

scene('policy', async () => {
  const p = await ensureDean();
  await go(p, 'policy', 'Scheduling Policy');
  await tid(p, 'policy-plain').waitFor({ timeout: 20000 });
  await shot(p, 'c3-policy', { clip: 'full', marks: [{ t: 'policy-submit', n: 1, at: 'tl' }] });
  await soft('policy-weeks', async () => {
    await tid(p, 'policy-weekGroups-table').scrollIntoViewIfNeeded();
    await shot(p, 'c3-policy-weeks', { clip: 'policy-weekGroups-table', pad: 60, marks: [{ t: 'policy-weekGroups-table', n: 1, at: 'tl', highlight: false }] });
  });
  await soft('policy-advanced', async () => {
    const adv = p.getByRole('button', { name: /Advanced \(system team\)/ }).first();
    await adv.scrollIntoViewIfNeeded();
    await shot(p, 'c3-policy-advanced', { clip: adv, pad: 24, marks: [{ t: adv, n: 1, at: 'tl' }] });
  });
});
