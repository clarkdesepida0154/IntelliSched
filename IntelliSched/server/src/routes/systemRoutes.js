// Phase 11.3: Administration -> System. Mounted behind `protect`; every route, reading included, is
// the Dean's alone (system.manage).
const express = require('express');
const router = express.Router();
const c = require('../controllers/systemController');
const { requirePermission } = require('../middleware/roles');

const dean = requirePermission('system.manage');
router.get('/system/about', dean, c.about);
router.get('/system/backups', dean, c.backups);
router.put('/system/backup-settings', dean, c.updateSettings);
router.post('/system/backups', dean, c.backUpNow);
router.get('/system/backups/:name/download', dean, c.download);
router.post('/system/restore/upload', dean, express.raw({ type: 'application/octet-stream', limit: '512mb' }), c.upload);
router.post('/system/restore/preview', dean, c.preview);
router.post('/system/restore', dean, c.restore);
router.put('/system/backup-password', dean, c.changePassword);
router.get('/system/warnings', dean, c.warnings);

module.exports = router;
