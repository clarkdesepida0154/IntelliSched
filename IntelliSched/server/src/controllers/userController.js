const User = require('../models/User');
const { ROLES } = require('../utils/permissions');

// The account states (the User model's list).
const STATUSES = User.schema.path('status').enumValues;

// A 400 answer that names every field to fix, for the form to show next to each field (the shape the
// other forms' answers have, academicController.js).
const fieldErrors = (res, errors) => res.status(400).json({
  success: false,
  message: errors.length === 1 ? errors[0].message : `${errors.length} fields need fixing: ${errors.map(e => e.message).join(' ')}`,
  errors
});

// The role and the status a request sets, checked against the lists before anything is written (the
// model's own enum check would end in a 500 with Mongoose's words). A field left out is not checked.
const choiceErrors = ({ role, status }) => [
  ...(role !== undefined && !ROLES.includes(role) ? [{ field: 'role', message: `Choose a role from the list: ${ROLES.join(', ')}.` }] : []),
  ...(status !== undefined && !STATUSES.includes(status) ? [{ field: 'status', message: `Choose an account status from the list: ${STATUSES.join(', ')}.` }] : [])
];

// Phase 12.1 (decision 2): never fewer than one active Dean. A change is refused when the account is
// an active Dean now, would not be one afterwards (locked or given another role), and no OTHER account
// is an active Dean. This covers the Dean's own account. (There is no delete route; an account is
// locked instead.) The Dean is also the only role that manages accounts (users.manage), so this keeps
// someone able to undo any change from the app. The code stays LAST_ACCOUNT_MANAGER for the pages.
const DEAN = 'Dean';
const LAST_ACCOUNT_MANAGER = {
  success: false,
  code: 'LAST_ACCOUNT_MANAGER',
  message: 'There must always be one active Dean account. Make another account an active Dean first, then change this one.'
};
const isActiveDean = ({ role, status }) => role === DEAN && status === 'Active';
const leavesNoManager = async (account, after) => {
  if (!isActiveDean(account) || isActiveDean(after)) return false;
  const others = await User.countDocuments({ _id: { $ne: account._id }, role: DEAN, status: 'Active' });
  return others === 0;
};

const PASSWORD_MIN = 8;
const cleanTitle = (title) => (title === undefined ? undefined : String(title ?? '').trim());

// @desc    Get all registered institutional accounts
// @route   GET /api/users
exports.getUsers = async (req, res, next) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.status(200).json({
      success: true,
      count: users.length,
      users
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create a new user with verified password and permissions
// @route   POST /api/users
exports.createUser = async (req, res, next) => {
  try {
    const { name, email, role, status, password, title } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Account full name is required.' });
    }

    const cleanEmail = email?.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!cleanEmail || !emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'A valid institutional email address is required.' });
    }

    // Reject fallback passwords: password must be explicitly supplied
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password is required and must be at least 8 characters long.'
      });
    }

    // A role or a status left out starts as Faculty and Active.
    const accountRole = role || 'Faculty';
    const accountStatus = status || 'Active';
    const problems = choiceErrors({ role: accountRole, status: accountStatus });
    if (problems.length) return fieldErrors(res, problems);

    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: `An account registered with "${cleanEmail}" already exists.`
      });
    }

    const newUser = await User.create({
      name: name.trim(),
      email: cleanEmail,
      role: accountRole,
      status: accountStatus,
      password: password,
      ...(cleanTitle(title) ? { title: cleanTitle(title) } : {})
    });

    const userObj = newUser.toObject();
    delete userObj.password;

    res.status(201).json({
      success: true,
      user: userObj
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update user permissions and role
// @route   PUT /api/users/:id
exports.updateUser = async (req, res, next) => {
  try {
    const { name, email, role, status, title, password } = req.body;

    const problems = choiceErrors({ role, status });
    if (name !== undefined && !String(name).trim()) problems.push({ field: 'name', message: 'Account full name is required.' });
    const cleanEmail = email === undefined ? undefined : String(email).toLowerCase().trim();
    if (cleanEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) problems.push({ field: 'email', message: 'A valid institutional email address is required.' });
    // Phase 12.1: a new password is optional on edit (the Dean edits their own account here too).
    if (password !== undefined && password !== '' && (typeof password !== 'string' || password.length < PASSWORD_MIN)) {
      problems.push({ field: 'password', message: `The new password needs at least ${PASSWORD_MIN} characters.` });
    }
    if (problems.length) return fieldErrors(res, problems);

    const account = await User.findById(req.params.id);
    if (!account) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }
    if (await leavesNoManager(account, { role: role ?? account.role, status: status ?? account.status })) {
      return res.status(409).json(LAST_ACCOUNT_MANAGER);
    }
    if (cleanEmail && cleanEmail !== account.email && await User.exists({ email: cleanEmail, _id: { $ne: account._id } })) {
      return res.status(409).json({ success: false, message: `An account registered with "${cleanEmail}" already exists.` });
    }

    if (name !== undefined) account.name = String(name).trim();
    if (cleanEmail !== undefined) account.email = cleanEmail;
    if (role !== undefined) account.role = role;
    if (status !== undefined) account.status = status;
    if (title !== undefined) account.title = cleanTitle(title) || undefined;
    if (typeof password === 'string' && password) account.password = password;   // hashed by the model
    await account.save({ validateModifiedOnly: true });

    const updatedUser = account.toObject();
    delete updatedUser.password;
    res.status(200).json({
      success: true,
      user: updatedUser
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Toggle user status (Active <-> Locked)
// @route   PATCH /api/users/:id/toggle
exports.toggleUserLock = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    const nextStatus = user.status === 'Active' ? 'Locked' : 'Active';
    if (await leavesNoManager(user, { role: user.role, status: nextStatus })) {
      return res.status(409).json(LAST_ACCOUNT_MANAGER);
    }
    user.status = nextStatus;
    await user.save({ validateBeforeSave: false });

    res.status(200).json({
      success: true,
      status: user.status,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        lastLogin: user.lastLogin
      }
    });
  } catch (err) {
    next(err);
  }
};