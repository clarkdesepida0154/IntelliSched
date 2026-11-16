import { useEffect, useState } from 'react';
import api from '../services/api';
import { useCurrentUser } from '../context/user';

// The signed-in user's role: the one App.jsx provides (context/user.js), or the currentUser a page was
// given; otherwise asked once from the gateway (GET /api/auth/me). null while it is still loading, ''
// when it is unknown. What a role may do comes from the permission map (utils/permissions.js, read
// through hooks/usePermission.js), never from a list of roles kept in a page.
export default function useRole(currentUser) {
  const signedIn = useCurrentUser();
  const given = currentUser?.role || signedIn?.role || null;
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (given) return undefined;
    let active = true;
    api.get('/auth/me')
      .then(res => { if (active) setFetched(res.data?.user?.role || ''); })
      .catch(() => { if (active) setFetched(''); });
    return () => { active = false; };
  }, [given]);
  return given ?? fetched;
}
