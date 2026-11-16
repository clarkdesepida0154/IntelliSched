// Reference lists (collection reference_lists): the business lists the client used to hard-code.
// One document per key: { key, label, items: [String] }. GET /api/reference-lists answers the stored
// lists, and these defaults (persisted: false) for a key with no document; it never writes. On Atlas
// the documents are created by the Phase 1 migration.
const REFERENCE_LIST_DEFAULTS = {
  // Engine 1 matches subjects against faculty profiles; specializations are stored verbatim on
  // faculty.specializations, so an entry is never renamed in place.
  specializationDomains: {
    label: 'Specialization domains',
    items: [
      'Software Engineering', 'Web Development', 'Mobile Application Development', 'Network Administration',
      'Data Science / AI', 'Machine Learning', 'Cybersecurity', 'Digital Forensics', 'Database Systems',
      'Information Management', 'Cloud Computing', 'Computer Programming', 'Systems Analysis & Design',
      'Human-Computer Interaction', 'Operating Systems', 'Computer Architecture', 'Discrete Mathematics',
      'Game Development', 'Multimedia & Graphics', 'IT Project Management', 'Embedded Systems / IoT',
      'Quality Assurance & Testing'
    ]
  },
  // Printed on the Teachers' Program (SF-029). Taken from the past Teachers' Programs (seed data).
  positionTitles: {
    label: 'Position titles',
    items: [
      'Instructor I', 'Instructor III', 'Assistant Professor I', 'Assistant Professor III', 'Assistant Professor IV',
      'Associate Professor I', 'Associate Professor V', 'Part-time Instructor'
    ]
  }
};
const REFERENCE_LIST_KEYS = Object.keys(REFERENCE_LIST_DEFAULTS);
// Lists that may never be empty: a faculty profile needs at least one specialization domain.
const MIN_ITEMS = { specializationDomains: 1 };
const MAX_ITEMS = 200;
const MAX_ITEM_LENGTH = 100;

// [{ field, message }] for a list of items; empty when valid.
const validateItems = (items, key = '') => {
  if (!Array.isArray(items)) return [{ field: 'items', message: 'Send the list as an array of names.' }];
  const errors = [];
  if (items.length < (MIN_ITEMS[key] || 0)) errors.push({ field: 'items', message: 'This list needs at least one entry: new faculty profiles pick from it.' });
  if (items.length > MAX_ITEMS) errors.push({ field: 'items', message: `A list holds at most ${MAX_ITEMS} entries.` });
  const seen = new Set();
  items.forEach((item, i) => {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text) errors.push({ field: `items.${i}`, message: 'An entry cannot be empty.' });
    else if (text.length > MAX_ITEM_LENGTH) errors.push({ field: `items.${i}`, message: `Keep each entry under ${MAX_ITEM_LENGTH} characters.` });
    else if (seen.has(text.toLowerCase())) errors.push({ field: `items.${i}`, message: `"${text}" is listed twice.` });
    seen.add(text.toLowerCase());
  });
  return errors;
};

module.exports = { REFERENCE_LIST_DEFAULTS, REFERENCE_LIST_KEYS, validateItems };
