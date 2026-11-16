const express = require('express');
const router = express.Router();
const policy = require('../controllers/policyController');
const { requirePermission } = require('../middleware/roles');

// Mounted behind `protect`: every signed-in user reads the policy. Changing it is settings.edit; its
// Advanced settings are advanced.edit, checked in the controller against the stored policy
// (utils/permissions.js; Phase 3 Step 6).
router.get('/policy', policy.getPolicy);
router.get('/policy/defaults', policy.getPolicyDefaults);
router.put('/policy', requirePermission('settings.edit'), policy.updatePolicy);

module.exports = router;
