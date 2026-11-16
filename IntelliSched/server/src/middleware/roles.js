// Permission checks (Phase 3 Step 6). Every write route names the action it needs from the one
// permission map (utils/permissions.js); reading is open to every signed-in user. Kept apart from
// authMiddleware (which needs JWT_SECRET at import) so route files can be mounted in tests with a
// stand-in `protect`.
const { PERMISSIONS, can, reasonFor } = require('../utils/permissions');

// The body of every permission refusal (a 403): the action and its plain reason. `code` tells a
// permission refusal apart from any other 403 (e.g. a locked account).
const notAllowed = (action, message = reasonFor(action)) => ({ success: false, code: 'NOT_ALLOWED', action, message });

// Middleware: the request goes on only when the signed-in user's role may do `action`. A misspelt
// action fails when the route file loads, never by refusing everyone.
const requirePermission = (action) => {
  if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, action)) {
    throw new Error(`Unknown permission action "${action}": utils/permissions.js lists the actions.`);
  }
  return (req, res, next) => (can(req.user?.role, action) ? next() : res.status(403).json(notAllowed(action)));
};

module.exports = { requirePermission, notAllowed };
