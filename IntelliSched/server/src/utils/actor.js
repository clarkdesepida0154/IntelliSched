// Who made a decision (Phase 2 Step 0). Every log or decision row the gateway writes stores the
// acting user as { id, name, role }. A row written automatically (a finished generation run) names
// "System" and keeps the user who started the action in startedBy.
const SYSTEM_ACTOR = Object.freeze({ id: 'SYSTEM', name: 'System', role: 'System' });

// The signed-in user of a request, or null when there is none (the row then reads "Not recorded").
const actorOf = (req) => {
  const user = req?.user;
  if (!user) return null;
  return {
    id: user._id !== undefined && user._id !== null ? String(user._id) : null,
    name: user.name || null,
    role: user.role || null
  };
};

// For rows the system writes on someone's behalf.
const systemActor = (startedBy = null) => ({ ...SYSTEM_ACTOR, ...(startedBy ? { startedBy } : {}) });

// "Maria Santos (Dean)", "System, started by Maria Santos (Dean)", or "Not recorded".
const describeActor = (actor) => {
  if (!actor || !actor.name) return 'Not recorded';
  const who = actor.role && actor.role !== actor.name ? `${actor.name} (${actor.role})` : actor.name;
  return actor.startedBy?.name ? `${who}, started by ${describeActor(actor.startedBy)}` : who;
};

module.exports = { SYSTEM_ACTOR, actorOf, systemActor, describeActor };
