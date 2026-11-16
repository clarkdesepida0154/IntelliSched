const express = require('express');
const router = express.Router();
const lists = require('../controllers/referenceListController');
const { requirePermission } = require('../middleware/roles');

// Mounted behind `protect`. Any signed-in user reads the lists; changing them is settings.edit
// (utils/permissions.js; Phase 3 Step 6).
router.get('/reference-lists', lists.getReferenceLists);
router.put('/reference-lists/:key', requirePermission('settings.edit'), lists.updateReferenceList);

module.exports = router;
