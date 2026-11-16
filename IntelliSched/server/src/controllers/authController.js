const jwt = require('jsonwebtoken');
const User = require('../models/User');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('[Security Fatal] JWT_SECRET environment variable is missing in authController.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

const AuditEvent = require('../models/AuditEvent');
const { actorOf } = require('../utils/actor');

// What the page may know about an account (never the hash).
const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  status: user.status,
  lastLogin: user.lastLogin,
  ...(user.title ? { title: user.title } : {}),
  mustChangePassword: Boolean(user.mustChangePassword)
});
exports.publicUser = publicUser;

const generateToken = (id, role) => {
  return jwt.sign({ id, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

// @desc    Authenticate institutional user & issue JWT
// @route   POST /api/auth/login
exports.login = async (req, res, next) => {
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both institutional email and password.'
      });
    }

    const cleanEmail = username.trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail }).select('+password');

    if (!user) {
      console.warn(`[Security Alert] Failed login attempt for non-existent account '${cleanEmail}' from IP: ${clientIp}`);
      return res.status(401).json({
        success: false,
        message: 'Invalid institutional credentials.'
      });
    }

    if (user.status === 'Locked') {
      console.warn(`[Security Alert] Rejected login attempt on locked account '${cleanEmail}' from IP: ${clientIp}`);
      return res.status(403).json({
        success: false,
        message: 'Account locked. Access revoked by system administration.'
      });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      console.warn(`[Security Alert] Failed password verification for account '${cleanEmail}' from IP: ${clientIp}`);
      return res.status(401).json({
        success: false,
        message: 'Invalid institutional credentials.'
      });
    }

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user._id, user.role);

    console.log(`[Auth Success] '${user.email}' (${user.role}) authenticated successfully from IP: ${clientIp}`);

    res.status(200).json({
      success: true,
      token,
      user: publicUser(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Retrieve active session user profile
// @route   GET /api/auth/me
exports.getMe = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const user = await User.findById(userId).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Active user session not found.'
      });
    }

    res.status(200).json({
      success: true,
      user: publicUser(user)
    });
  } catch (error) {
    next(error);
  }
};

// Phase 12.1 (decision 2): the first sign-in with a starting password. The signed-in user gives the
// current password and a new one twice (at least 8 characters, not the current one); the flag is
// cleared and one Audit Trail row is written, without any password. Also used by anyone who simply
// wants to change their own password.
const PASSWORD_MIN = 8;
exports.changePassword = async (req, res, next) => {
  try {
    const { current, next: nextPassword, confirm } = req.body || {};
    const errors = [];
    if (typeof current !== 'string' || !current) errors.push({ field: 'current', message: 'Type your current password.' });
    if (typeof nextPassword !== 'string' || nextPassword.length < PASSWORD_MIN) errors.push({ field: 'next', message: `The new password needs at least ${PASSWORD_MIN} characters.` });
    else if (nextPassword !== confirm) errors.push({ field: 'confirm', message: 'The two new passwords are not the same.' });
    else if (nextPassword === current) errors.push({ field: 'next', message: 'Choose a password different from the starting one.' });
    if (errors.length) return res.status(400).json({ success: false, message: errors[0].message, errors });

    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'Active user session not found.' });
    if (!(await user.matchPassword(current))) {
      return res.status(400).json({ success: false, message: 'The current password is not right.', errors: [{ field: 'current', message: 'The current password is not right.' }] });
    }
    const wasStarting = Boolean(user.mustChangePassword);
    user.password = nextPassword;
    user.mustChangePassword = undefined;
    await user.save({ validateBeforeSave: false });
    try {
      await AuditEvent.create({
        action: 'password-change',
        category: 'Users',
        target: user.name,
        detail: wasStarting ? 'Changed the starting password at the first sign-in.' : 'Changed their own password.',
        actor: actorOf(req),
        at: new Date()
      });
    } catch (err) {
      console.error('[Auth] The Audit Trail entry could not be written:', err.message);
    }
    res.status(200).json({ success: true, message: 'Password changed.', user: publicUser(user) });
  } catch (error) {
    next(error);
  }
};