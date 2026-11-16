const mongoose = require('mongoose');

// A window in which a borrowed room may be used (24-hour "HH:MM" on the policy grid).
const availabilityWindowSchema = new mongoose.Schema({
  day: { type: String, required: true },
  start: { type: String, required: true },
  end: { type: String, required: true }
}, { _id: false });

const facilitySchema = new mongoose.Schema({
  roomName: {
    type: String,
    required: [true, 'Room name/identifier is required'],
    unique: true,
    trim: true,
    uppercase: true
  },
  type: {
    type: String,
    required: true,
    enum: ['LEC', 'LAB']
  },
  // Optional and informational: the scheduler ignores it unless the Scheduling Policy's
  // enforceCapacity is on (HC6 is then skipped when either number is missing).
  capacity: {
    type: Number,
    min: 1,
    max: 300
  },
  // Optional; nothing invents a building.
  building: {
    type: String,
    trim: true
  },
  // Empty: the room is available whenever the policy allows. Non-empty: ONLY in these windows
  // (a room borrowed from another department). Checked by HC4 after placement.
  availability: {
    type: [availabilityWindowSchema],
    default: []
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

facilitySchema.index({ type: 1, isActive: 1 });

module.exports = mongoose.model('Facility', facilitySchema, 'facilities');