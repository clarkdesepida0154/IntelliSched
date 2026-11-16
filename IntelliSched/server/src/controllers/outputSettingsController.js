const OutputSettings = require('../models/OutputSettings');
const AuditEvent = require('../models/AuditEvent');
const { defaultOutputSettings, mergeOutputSettings, validateOutputSettings } = require('../utils/outputSettings');
const { actorOf, describeActor } = require('../utils/actor');

// The parts of the settings in the Dean's words, for the Audit Trail's detail.
const PART_NAMES = {
  campusCode: 'campus code',
  collegeName: 'college name',
  teachersProgram: "Teachers' Program",
  motherSchedule: 'Mother Schedule',
  roomProgram: 'Room Program',
  showEvaluationRatings: '"Show evaluation ratings on screen"'
};
const changedParts = (before, after) => Object.keys(PART_NAMES)
  .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  .map(key => PART_NAMES[key]);

// The answer of both routes, shaped like GET /api/policy's: the settings merged over the defaults,
// whether a document is stored, and who saved it last ("Maria Santos (Dean)") and when.
const view = (stored) => (stored
  ? {
    ...mergeOutputSettings(stored, undefined),
    persisted: true,
    updatedBy: stored.updatedBy?.name ? describeActor(stored.updatedBy) : null,
    updatedAt: stored.updatedAt || null
  }
  : { ...defaultOutputSettings(), persisted: false });

// GET /api/output-settings (any signed-in user: every output prints with them). The stored settings,
// or the defaults with persisted: false. Never writes: an empty database stays empty.
exports.getOutputSettings = async (req, res, next) => {
  try {
    const stored = await OutputSettings.findOne({ key: OutputSettings.ACTIVE_KEY }).lean();
    res.status(200).json(view(stored));
  } catch (err) {
    next(err);
  }
};

// GET /api/output-settings/defaults (any signed-in user). The defaults, whatever is stored: what the
// Output Settings page puts back, e.g. the Teachers' Program's professor line ("Conformed/Received
// by:", filled in with the professor's name and position) after it was removed and saved.
exports.getOutputSettingsDefaults = (req, res) => {
  res.status(200).json(defaultOutputSettings());
};

// PUT /api/output-settings (settings.edit: the Dean). Creates or updates the one document. The body may be
// partial; it is merged over the stored settings (or the defaults), keys the settings don't have are
// dropped, and the whole result is validated.
exports.updateOutputSettings = async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const stored = await OutputSettings.findOne({ key: OutputSettings.ACTIVE_KEY }).lean();
    const before = stored ? mergeOutputSettings(stored, undefined) : defaultOutputSettings();
    const next_ = mergeOutputSettings(before, body);

    const errors = validateOutputSettings(next_);
    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: `The Output Settings were not saved: ${errors.length === 1 ? 'one field needs' : `${errors.length} fields need`} fixing.`,
        errors
      });
    }

    const saved = await OutputSettings.findOneAndUpdate(
      { key: OutputSettings.ACTIVE_KEY },
      { $set: { ...next_, key: OutputSettings.ACTIVE_KEY, updatedBy: actorOf(req) } },
      { upsert: true, new: true, lean: true, runValidators: true }
    );
    // Who saved it (the Audit Trail's By column); the parts that changed are named.
    const changed = changedParts(before, next_);
    await AuditEvent.create({
      action: 'output-settings-save',
      category: 'Settings',
      target: 'Output Settings',
      detail: changed.length ? `Saved the Output Settings (${changed.join(', ')}).` : 'Saved the Output Settings (no changes).',
      actor: actorOf(req)
    });
    res.status(200).json(view(saved));
  } catch (err) {
    next(err);
  }
};
