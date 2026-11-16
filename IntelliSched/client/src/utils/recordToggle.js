import api from '../services/api';

// Undo of a disable (Phase 3 Step 5, audit X6), for a subject, a room, a section or a faculty member.
// The gateway's toggle routes (PATCH /<records>/:id/toggle) flip isActive rather than set it, so the
// record is toggled once more only when it is still disabled, i.e. unchanged since the disable: its
// list is read first, and a record someone enabled again meanwhile is left as it is.
//   listPath    the list the record is in ('/facilities', '/sections', '/faculty', '/catalog')
//   togglePath  its toggle route
//   id, name    the record's _id, and its name as the page shows it
// Resolves { isActive, message, tone }: isActive is the record's state now (undefined when it could not
// be read), message says what happened in plain words, tone is 'success' or 'error'. Never throws.
export const undoDisable = async ({ listPath, togglePath, id, name }) => {
  let current;
  try {
    const res = await api.get(listPath);
    current = (Array.isArray(res.data) ? res.data : []).find(r => String(r._id) === String(id));
  } catch (err) {
    return { message: `${name} could not be enabled again (${err.response?.data?.message || err.message}). Nothing changed: press "Enable" on its row to try again.`, tone: 'error' };
  }
  if (!current) return { message: `${name} no longer exists, so it could not be enabled again.`, tone: 'error' };
  if (current.isActive) return { isActive: true, message: `${name} was already enabled again (by someone else); nothing changed.`, tone: 'success' };
  try {
    const res = await api.patch(togglePath);
    const isActive = Boolean(res.data?.isActive);
    return isActive
      ? { isActive, message: `Undone: ${name} is enabled again.`, tone: 'success' }
      : { isActive, message: `${name} was changed by someone else meanwhile and is disabled now. Press "Enable" on its row to enable it.`, tone: 'error' };
  } catch (err) {
    return { isActive: false, message: `${name} could not be enabled again (${err.response?.data?.message || err.message}). It is still disabled: press "Enable" on its row to try again.`, tone: 'error' };
  }
};
