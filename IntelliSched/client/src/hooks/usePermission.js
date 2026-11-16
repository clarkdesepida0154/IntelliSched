import useRole from './useRole';
import { can, reasonFor } from '../utils/permissions';

// Phase 3 Step 6: whether the signed-in role may do one action of the permission map
// (utils/permissions.js, the gateway's own map mirrored), and why not, in the map's plain words.
//   const edit = usePermission('data.edit');  ->  { allowed, reason, loading }
// While the role is still being read nothing is allowed, and the reason says so. A write control the
// role may not use is disabled and says why: the reason is shown next to it (PermissionNote, or the
// control's own reason line) and is its accessible description (blockedBy below). The gateway refuses
// the same actions with the same words (403 NOT_ALLOWED), and a page shows that message when it comes.
// Viewing, printing and downloading a CSV file need no permission.
export const CHECKING_PERMISSION = 'Checking what you may change…';

export default function usePermission(action) {
  const role = useRole();
  if (role === null) return { allowed: false, reason: CHECKING_PERMISSION, loading: true };
  const allowed = can(role, action);
  return { allowed, reason: allowed ? '' : reasonFor(action), loading: false };
}

// The props a write control gets while the role may not use it: the reason as its title, and as its
// accessible description through the visible note with this id (none while the role may use it).
export const blockedBy = (permission, noteId) => (permission.allowed ? {} : { title: permission.reason, 'aria-describedby': noteId });
