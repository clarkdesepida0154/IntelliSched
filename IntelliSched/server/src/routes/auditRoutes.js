const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');

// Mounted behind `protect`: the Audit Trail is readable by every signed-in user (the Term Checklist
// reads it for everyone).
router.get('/audit/logs', auditController.getAuditLogs);

module.exports = router;
