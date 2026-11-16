const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Enforce required JWT secret from environment
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('[Security Fatal] JWT_SECRET environment variable is unset. Refusing to initialize auth middleware.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

// 1. Verify Bearer JWT Token (Zero-Bypass Policy)
exports.protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Access token missing.'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Phase 11.3: after a restore every user signs in again (backup/sessions.js).
    if (await require('../backup/sessions').tokenEnded(decoded.iat)) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_ENDED',
        message: 'The system was restored from a backup. Sign in again.'
      });
    }
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session. Account record not found.'
      });
    }

    if (user.status === 'Locked') {
      return res.status(403).json({
        success: false,
        message: 'Account locked by administrator. Access revoked.'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication session.'
    });
  }
};

// Phase 12.1 (decision 2): an account still on its starting password opens nothing until it has
// chosen its own. Mounted on /api after `protect`; the sign-in routes (/api/auth: me and
// change-password) are mounted before it, and the live-update feed stays readable.
const OPEN_WHILE_STARTING = new Set(['/changes']);
exports.requireOwnPassword = (req, res, next) => {
  if (!req.user?.mustChangePassword || OPEN_WHILE_STARTING.has(req.path)) return next();
  return res.status(403).json({
    success: false,
    code: 'PASSWORD_CHANGE_REQUIRED',
    message: 'Change your starting password first.'
  });
};

// What a signed-in user may do is checked on each write route, from the one permission map
// (middleware/roles.js requirePermission, utils/permissions.js; Phase 3 Step 6).