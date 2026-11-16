// Phase 6 (decision 6): whether anyone on the current faculty has taught a catalog subject before, read
// from the teaching history the term loader writes on each professor (Faculty.teachingHistory, built from
// the past Teachers' Programs; the same history the ranking's features count). The Recommendations page
// then says, above that class's ranking, that the ranking is weak. Joined by the catalog _id, never by the
// code (ITST 301-306 are different subjects on each BSIT track).
//
// nobodyTaughtBefore(subject, faculty) -> true | false | null
//   true   some active professor has a teaching history, and none of them has this subject in it;
//   false  at least one of them taught it;
//   null   nobody has any teaching history on record (a database the term loader never filled), so
//          nothing can be said.
const hasTaught = (entry, id) => String(entry?.subjectId ?? '') === id
  && (Number(entry.timesTaught) > 0 || (Array.isArray(entry.terms) && entry.terms.length > 0));

const nobodyTaughtBefore = (subject, faculty) => {
  const id = String(subject?._id ?? '');
  const withHistory = (faculty || []).filter(f => Array.isArray(f?.teachingHistory) && f.teachingHistory.length > 0);
  if (!id || !withHistory.length) return null;
  return !withHistory.some(f => f.teachingHistory.some(entry => hasTaught(entry, id)));
};

module.exports = { nobodyTaughtBefore };
