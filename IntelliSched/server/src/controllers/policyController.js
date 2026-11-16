const SchedulingPolicy = require('../models/SchedulingPolicy');
const AuditEvent = require('../models/AuditEvent');
const { defaultPolicy, resetPolicy, mergePolicy, validatePolicy, normalizePolicy, advancedPolicyChanges, describeAdvancedChanges } = require('../utils/policy');
const { actorOf } = require('../utils/actor');
const { can } = require('../utils/permissions');

// Phase 3 Step 4: the Advanced settings ("Advanced (system team)") are advanced.edit in the permission
// map (Step 6; the Dean's alone since Phase 8 Part 8); a role with settings.edit
// but not advanced.edit changes only the plain ones (utils/policy.js PLAIN_POLICY_FIELDS).

// GET /api/policy. The stored policy (merged over the defaults), or the defaults with
// persisted: false. Never writes: an empty database stays empty.
exports.getPolicy = async (req, res, next) => {
  try {
    const stored = await SchedulingPolicy.findOne({ key: SchedulingPolicy.ACTIVE_KEY }).lean();
    if (!stored) return res.status(200).json({ ...defaultPolicy(), persisted: false });
    res.status(200).json({
      ...mergePolicy(stored, undefined),
      persisted: true,
      updatedBy: stored.updatedBy || null,
      updatedAt: stored.updatedAt || null
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/policy/defaults. What "Reset to defaults" restores (Phase 8 Part 8, decision 3f: with Friday
// kept as the office's Extension day).
exports.getPolicyDefaults = (req, res) => {
  res.status(200).json(resetPolicy());
};

// PUT /api/policy (settings.edit: the Dean). Creates or updates the one active
// document. The body may be partial; it is merged over the stored policy (or the defaults) and the
// whole result is validated. Anyone who may not change the Advanced settings (advanced.edit) may change
// only the plain settings (the days, the hours, the lunch rule, Saturday on or off): the merged result
// is compared with the stored (or default) policy value by value, so a body that repeats every setting
// (the page's Save, or its Reset with every default) is allowed as long as no Advanced value changes.
// Refused with 403 ADVANCED_ONLY (Step 4's code, which the page reads) before anything is validated or
// written.
exports.updatePolicy = async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const stored = await SchedulingPolicy.findOne({ key: SchedulingPolicy.ACTIVE_KEY }).lean();
    const current = stored ? mergePolicy(stored, undefined) : defaultPolicy();
    const next_ = mergePolicy(current, body);

    const plainOnly = !can(req.user?.role, 'advanced.edit');
    if (plainOnly) {
      const fields = advancedPolicyChanges(current, next_);
      if (fields.length) {
        return res.status(403).json({
          success: false,
          code: 'ADVANCED_ONLY',
          fields,
          message: `Only the Dean can change the Advanced settings (${describeAdvancedChanges(fields)}).`
        });
      }
    }

    // Someone who may change only the plain settings hears of a problem at the plain setting they can
    // fix (e.g. a class day too short for the lab start times is named at the day's start or end).
    const errors = validatePolicy(next_, { plainOnly });
    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: `The policy was not saved: ${errors.length === 1 ? 'one setting needs' : `${errors.length} settings need`} fixing.`,
        errors
      });
    }

    const saved = await SchedulingPolicy.findOneAndUpdate(
      { key: SchedulingPolicy.ACTIVE_KEY },
      { $set: { ...normalizePolicy(next_), key: SchedulingPolicy.ACTIVE_KEY, updatedBy: req.user?.name || 'Unknown user' } },
      { upsert: true, new: true, lean: true }
    );
    // Who saved it (the Audit Trail's By column); the changed top-level groups are named.
    const changed = Object.keys(body).filter(k => k in next_).join(', ');
    await AuditEvent.create({
      action: 'policy-save',
      category: 'Settings',
      target: 'Scheduling Policy',
      detail: changed ? `Saved the Scheduling Policy (${changed}).` : 'Saved the Scheduling Policy.',
      actor: actorOf(req)
    });
    res.status(200).json({
      ...mergePolicy(saved, undefined),
      persisted: true,
      updatedBy: saved.updatedBy || null,
      updatedAt: saved.updatedAt || null
    });
  } catch (err) {
    next(err);
  }
};
