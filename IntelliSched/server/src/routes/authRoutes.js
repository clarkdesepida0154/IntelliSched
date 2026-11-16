const express = require('express');
const router = express.Router();
const { login, getMe, changePassword } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/login', login);
router.get('/me', protect, getMe);
// Phase 12.1: the signed-in user's own password (the starting password's first sign-in included).
router.post('/change-password', protect, changePassword);

module.exports = router;