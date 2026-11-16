const ReferenceList = require('../models/ReferenceList');
const AuditEvent = require('../models/AuditEvent');
const { actorOf } = require('../utils/actor');
const { REFERENCE_LIST_DEFAULTS, REFERENCE_LIST_KEYS, validateItems } = require('../utils/referenceLists');

const view = (key, stored) => (stored
  ? { key, label: stored.label || REFERENCE_LIST_DEFAULTS[key].label, items: stored.items || [], persisted: true, updatedBy: stored.updatedBy || null, updatedAt: stored.updatedAt || null }
  : { key, label: REFERENCE_LIST_DEFAULTS[key].label, items: [...REFERENCE_LIST_DEFAULTS[key].items], persisted: false });

// GET /api/reference-lists: every list, stored or default. Never writes.
exports.getReferenceLists = async (req, res, next) => {
  try {
    const stored = await ReferenceList.find({ key: { $in: REFERENCE_LIST_KEYS } }).lean();
    const byKey = new Map(stored.map(d => [d.key, d]));
    res.status(200).json({ success: true, lists: Object.fromEntries(REFERENCE_LIST_KEYS.map(key => [key, view(key, byKey.get(key))])) });
  } catch (err) {
    next(err);
  }
};

// PUT /api/reference-lists/:key { items } (settings.edit: the Dean): replaces one list.
exports.updateReferenceList = async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!REFERENCE_LIST_KEYS.includes(key)) {
      return res.status(404).json({ success: false, message: `There is no reference list named ${key}.` });
    }
    const errors = validateItems(req.body?.items, key);
    if (errors.length) return res.status(400).json({ success: false, message: 'The list was not saved: fix the entries marked below.', errors });
    const items = req.body.items.map(item => item.trim());
    const saved = await ReferenceList.findOneAndUpdate(
      { key },
      { $set: { key, label: REFERENCE_LIST_DEFAULTS[key].label, items, updatedBy: req.user?.name || 'Unknown user' } },
      { upsert: true, new: true, lean: true }
    );
    await AuditEvent.create({
      action: 'reference-list-save',
      category: 'Settings',
      target: REFERENCE_LIST_DEFAULTS[key].label,
      detail: `Saved the list (${items.length} entries).`,
      actor: actorOf(req)
    });
    res.status(200).json({ success: true, list: view(key, saved) });
  } catch (err) {
    next(err);
  }
};
