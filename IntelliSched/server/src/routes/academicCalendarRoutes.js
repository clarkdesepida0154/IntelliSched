// Phase 13 (decision 2): the Academic calendar. Mounted behind `protect`: every signed-in role reads it
// (the term picker's years and the default term); saving it is the Dean's (system.manage), audited.
const express = require('express');
const router = express.Router();
const c = require('../controllers/academicCalendarController');
const { requirePermission } = require('../middleware/roles');

router.get('/academic-calendar', c.getCalendar);
router.put('/system/academic-calendar', requirePermission('system.manage'), c.updateCalendar);

module.exports = router;
