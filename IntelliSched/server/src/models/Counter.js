const mongoose = require('mongoose');

// Atomic sequence counters ({ _id: name, seq }), advanced with $inc. Used for faculty codes.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 }
}, { versionKey: false });

module.exports = mongoose.model('Counter', counterSchema, 'counters');
