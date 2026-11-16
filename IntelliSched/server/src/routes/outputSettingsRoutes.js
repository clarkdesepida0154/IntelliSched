const express = require('express');
const router = express.Router();
const outputSettings = require('../controllers/outputSettingsController');
const { requirePermission } = require('../middleware/roles');

// Mounted behind `protect`: every route needs a signed-in user. Anyone reads the Output Settings (every
// output prints with them) and their defaults; changing them is settings.edit (utils/permissions.js;
// Phase 3 Step 6).
router.get('/output-settings', outputSettings.getOutputSettings);
router.get('/output-settings/defaults', outputSettings.getOutputSettingsDefaults);
router.put('/output-settings', requirePermission('settings.edit'), outputSettings.updateOutputSettings);

module.exports = router;
