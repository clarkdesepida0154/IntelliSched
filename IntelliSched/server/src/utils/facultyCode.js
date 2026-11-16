// Faculty codes ("FAC-008") from an atomic counter: concurrent creates can never get the same code,
// unlike the old count + 1. The counter always starts above the highest existing FAC- number.
const mongoose = require('mongoose');
const Counter = require('../models/Counter');
const Faculty = require('../models/Faculty');
const { LIVE_DB_NAME } = require('../config/db');

const COUNTER_ID = 'facultyId';

class CounterMissingError extends Error {
  constructor() {
    super('The faculty code counter does not exist yet. It is created by the Phase 1 migration (run with --apply by a person); until then new faculty cannot be added.');
    this.name = 'CounterMissingError';
    this.status = 503;
  }
}

const formatCode = (n) => `FAC-${String(n).padStart(3, '0')}`;

// The highest number used by any FAC-### code, or 0.
const highestFacultyNumber = async () => {
  const codes = await Faculty.find({ facultyId: /^FAC-\d+$/ }).select('facultyId').lean();
  return codes.reduce((max, f) => Math.max(max, Number(f.facultyId.slice(4)) || 0), 0);
};

// Raises the counter to at least the highest existing number (creating it when allowed).
const ensureCounterAbove = (highest) =>
  Counter.updateOne({ _id: COUNTER_ID }, { $max: { seq: highest } }, { upsert: true });

// Returns the next code. On the live database the counter is created only by the migration, so a
// missing counter there is an error; anywhere else it is created above the highest existing code.
const nextFacultyCode = async ({ allowInit = mongoose.connection.name !== LIVE_DB_NAME } = {}) => {
  const counter = await Counter.findById(COUNTER_ID).lean();
  if (!counter) {
    if (!allowInit) throw new CounterMissingError();
    await ensureCounterAbove(await highestFacultyNumber());
  }
  const { seq } = await Counter.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { seq: 1 } }, { new: true }).lean();
  return formatCode(seq);
};

module.exports = { nextFacultyCode, highestFacultyNumber, ensureCounterAbove, formatCode, CounterMissingError, COUNTER_ID };
