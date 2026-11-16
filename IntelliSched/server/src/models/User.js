const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
// The roles an account may have come from the one permission map (Phase 3 Step 6 added the College
// Secretary).
const { ROLES } = require('../utils/permissions');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Account name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email address is required'],
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false // Excluded from default queries for security
  },
  role: {
    type: String,
    required: true,
    enum: ROLES,
    default: 'Faculty'
  },
  status: {
    type: String,
    enum: ['Active', 'Locked'],
    default: 'Active'
  },
  lastLogin: {
    type: Date,
    default: null
  },
  // Phase 12.1 (decision 2): an optional title shown with the name ("Dean, CCS"), and the starting
  // password's flag: an account with mustChangePassword signs in normally but opens nothing until it
  // has chosen its own password (POST /api/auth/change-password). Accounts without the field are
  // unaffected.
  title: {
    type: String,
    trim: true,
    default: undefined
  },
  mustChangePassword: {
    type: Boolean,
    default: undefined
  }
}, { timestamps: true });

// Hash password prior to saving document
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare entered plaintext password with stored hash
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema, 'users');