import { useState, useEffect } from 'react';
import { Search, Plus, UserCog, MoreVertical, Edit, Ban, Shield, Mail, Loader2, CheckCircle2, X, ShieldCheck, AlertCircle, RefreshCw, AlertOctagon, Eye, EyeOff } from 'lucide-react';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import PermissionNote from '../../components/ui/PermissionNote';
import TablePagination from '../../components/ui/TablePagination';
import usePagination from '../../hooks/usePagination';
import usePermission, { blockedBy } from '../../hooks/usePermission';
import { useCurrentUser } from '../../context/user';
import { PERMISSIONS, ROLES, can } from '../../utils/permissions';
import { roleAbilitiesText, ROLE_SUMMARY } from '../../utils/permissionText';
import Select from '../../components/ui/Select';

// Users & Roles (Phase 3 Step 6): every signed-in role sees the accounts; creating, editing, locking
// and reactivating them is the permission map's users.manage (the gateway checks the same action). The
// roles offered are the map's ROLES (the User model's), and the form says what the chosen role may do.
// The signed-in user's own account can't be locked here (Lock Account, or the Status in the form): it
// would sign them out. The gateway also refuses any change that leaves no active account that can
// manage accounts (409
// LAST_SYSTEM_ADMIN), and its message is shown.
const MANAGE_NOTE_ID = 'users-permission-note';
const OWN_LOCK_REASON = "You can't lock your own account: you would be signed out and could not sign in until another Dean unlocks it.";
// A new account starts with the role that may change the least (the least privilege, from the map).
const actionCount = (role) => Object.keys(PERMISSIONS).filter(action => can(role, action)).length;
const NEW_ACCOUNT_ROLE = [...ROLES].sort((a, b) => actionCount(a) - actionCount(b))[0];
const EMPTY_FORM = { name: '', email: '', title: '', password: '', role: NEW_ACCOUNT_ROLE, status: 'Active' };

export default function UserManagement() {
  const manage = usePermission('users.manage');
  // The signed-in user ({ id } from the gateway's sign-in); their own row is the account with that id.
  const signedIn = useCurrentUser();
  const ownId = String(signedIn?.id ?? signedIn?._id ?? '');
  const isOwnActiveAccount = (user) => Boolean(ownId) && String(user?._id) === ownId && user.status === 'Active';
  const [usersList, setUsersList] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [activeUser, setActiveUser] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState('');
  // The gateway's field errors (role, status), shown next to their fields.
  const [fieldErrors, setFieldErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let isMounted = true;

    async function loadUsers() {
      try {
        const res = await api.get('/users');
        if (!isMounted) return;
        if (res.data?.success && Array.isArray(res.data?.users)) {
          setUsersList(res.data.users);
        } else if (Array.isArray(res.data)) {
          setUsersList(res.data);
        } else {
          setUsersList([]);
        }
      } catch (err) {
        if (!isMounted) return;
        console.warn('[UserManagement] API offline:', err.message);
        setUsersList([]);
        setErrorMessage(err.response?.data?.message || 'The accounts could not be loaded. Check that the web server is running, then press Refresh.');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadUsers();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setErrorMessage('');
    try {
      const res = await api.get('/users');
      if (res.data?.success && Array.isArray(res.data?.users)) {
        setUsersList(res.data.users);
      } else if (Array.isArray(res.data)) {
        setUsersList(res.data);
      } else {
        setUsersList([]);
      }
      setToast({ message: 'The account list is up to date.' });
    } catch (err) {
      setUsersList([]);
      setErrorMessage(err.response?.data?.message || 'The accounts could not be loaded. Check that the web server is running, then press Refresh.');
    } finally {
      setIsRefreshing(false);
      setTimeout(() => setToast(null), 3000);
    }
  };

  const toggleDropdown = (id) => {
    if (!manage.allowed) return;
    setActiveDropdown(activeDropdown === id ? null : id);
  };

  const openAddModal = () => {
    if (!manage.allowed) return;
    setActiveUser(null);
    setFormData(EMPTY_FORM);
    setShowPassword(false);
    setValidationError('');
    setFieldErrors({});
    setIsAddModalOpen(true);
    setActiveDropdown(null);
  };

  const openEditModal = (user) => {
    if (!manage.allowed) return;
    setActiveUser(user);
    setFormData({ name: user.name, email: user.email, title: user.title || '', password: '', role: user.role, status: user.status });
    setShowPassword(false);
    setValidationError('');
    setFieldErrors({});
    setIsEditModalOpen(true);
    setActiveDropdown(null);
  };

  const handleToggleLock = async (user) => {
    if (!manage.allowed || isOwnActiveAccount(user)) return;
    try {
      const res = await api.patch(`/users/${user._id}/toggle`);
      const updatedStatus = res.data?.status || (user.status === 'Active' ? 'Locked' : 'Active');

      setUsersList(prev => prev.map(u => u._id === user._id ? { ...u, status: updatedStatus } : u));
      setToast({
        message: updatedStatus === 'Locked'
          ? `Account for ${user.name} has been locked.`
          : `Account for ${user.name} has been reactivated.`
      });
    } catch (err) {
      // The gateway's own words (a 403 names who may manage accounts).
      setToast({ message: `${user.name}'s account was not changed: ${err.response?.data?.message || err.message}` });
    } finally {
      setActiveDropdown(null);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const handleSaveUser = async (e) => {
    e.preventDefault();
    if (!manage.allowed) return;
    setValidationError('');
    setFieldErrors({});

    const cleanName = formData.name.trim();
    const cleanEmail = formData.email.trim().toLowerCase();

    if (!cleanName) {
      setValidationError('Account full name is required.');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      setValidationError('Please provide a valid institutional email address.');
      return;
    }

    if (!activeUser && (!formData.password || formData.password.length < 8)) {
      setValidationError('Password must be at least 8 characters long.');
      return;
    }
    // Phase 12.1: on edit a new password is optional (the Dean changes their own here too).
    if (activeUser && formData.password && formData.password.length < 8) {
      setFieldErrors({ password: 'The new password needs at least 8 characters.' });
      setValidationError('The account was not saved. Fix the fields marked below.');
      return;
    }

    setIsSubmitting(true);
    const isEdit = Boolean(activeUser);

    try {
      if (isEdit) {
        const res = await api.put(`/users/${activeUser._id}`, {
          name: cleanName,
          email: cleanEmail,
          title: formData.title.trim(),
          role: formData.role,
          status: formData.status,
          ...(formData.password ? { password: formData.password } : {})
        });
        setUsersList(prev => prev.map(u => u._id === activeUser._id ? res.data.user : u));
        setToast({ message: formData.password ? `Account and password saved for ${cleanName}.` : `Account saved for ${cleanName}.` });
      } else {
        const res = await api.post('/users', {
          name: cleanName,
          email: cleanEmail,
          password: formData.password,
          title: formData.title.trim(),
          role: formData.role,
          status: formData.status
        });
        setUsersList(prev => [res.data.user, ...prev]);
        setToast({ message: `Account created for ${cleanName} with ${formData.role} privileges.` });
      }

      setIsAddModalOpen(false);
      setIsEditModalOpen(false);
    } catch (err) {
      // The gateway's words (a 409 when no active account that can manage accounts would be left, a 403 naming who may
      // manage accounts). Field errors go next to their fields too. The form keeps what was typed.
      const errors = Array.isArray(err.response?.data?.errors) ? err.response.data.errors.filter(e => e?.field) : [];
      setFieldErrors(Object.fromEntries(errors.map(e => [e.field, e.message])));
      setValidationError(errors.length ? 'The account was not saved. Fix the fields marked below.' : (err.response?.data?.message || 'Failed to save account.'));
    } finally {
      setIsSubmitting(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const filteredUsers = usersList.filter(user =>
    user.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.role?.toLowerCase().includes(searchQuery.toLowerCase())
  );
  // Pages of 25 accounts (the table standard; Phase 3 Step 8).
  const { pageItems: shownUsers, currentPage, totalPages, setPage, resetPage, rangeLabel } = usePagination(filteredUsers, 25);

  return (
    <div className="animate-in fade-in duration-300 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col mb-6">
        
        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="users-roles" />

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} aria-hidden="true" />
              <input 
                type="text" 
                placeholder="Search accounts..." 
                value={searchQuery} 
                onChange={(e) => { setSearchQuery(e.target.value); resetPage(); }} 
                className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white transition-colors" 
              />
            </div>
            <button 
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing || isLoading}
              className="p-2 bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer disabled:opacity-50"
              title="Refresh User Directory"
            >
              <RefreshCw size={18} className={isRefreshing ? 'animate-spin text-blue-500' : ''} />
            </button>
            <button
              type="button"
              data-testid="users-add"
              onClick={openAddModal}
              disabled={!manage.allowed}
              {...blockedBy(manage, MANAGE_NOTE_ID)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center transition-colors shadow-lg shadow-blue-900/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
            >
              <Plus size={16} className="mr-2" /> Add User
            </button>
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {!manage.allowed && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={MANAGE_NOTE_ID} permission={manage} lead="You can view the accounts and their roles." />
          </div>
        )}

        {/* USERS TABLE */}
        <div className="overflow-x-auto relative min-h-[220px] custom-scrollbar">
          {isLoading ? (
            <div className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-400 gap-3">
              <Loader2 size={36} className="animate-spin text-blue-500" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading the accounts…</p>
            </div>
          ) : errorMessage ? (
            <div className="p-12 text-center max-w-md mx-auto my-8">
              <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The accounts could not be loaded</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">{errorMessage}</p>
              <button
                type="button"
                onClick={handleRefresh}
                className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 transition-colors cursor-pointer"
              >
                Retry Request
              </button>
            </div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 dark:bg-[#1a1a1c] border-b border-slate-200 dark:border-slate-800/60 text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="px-6 py-4 font-bold tracking-wider uppercase text-xs">User Account</th>
                  <th className="px-6 py-4 font-bold tracking-wider uppercase text-xs">Contact Information</th>
                  <th className="px-6 py-4 font-bold tracking-wider uppercase text-xs text-center">Institutional Role</th>
                  <th className="px-6 py-4 font-bold tracking-wider uppercase text-xs text-center">Account State</th>
                  <th className="px-6 py-4 font-bold tracking-wider uppercase text-xs text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="p-12 text-center text-slate-600 dark:text-slate-400">
                      <UserCog size={32} className="mx-auto mb-2 opacity-30 text-blue-500" />
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">No User Accounts Registered</p>
                      <p className="text-xs mt-1">{manage.allowed ? 'Click "Add User" above to provision an institutional user account.' : manage.reason}</p>
                    </td>
                  </tr>
                ) : (
                  shownUsers.map((user, idx) => {
                    const isNearBottom = idx >= shownUsers.length - 2 && shownUsers.length > 2;

                    return (
                      <tr key={user._id} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors group">
                        <td className="px-6 py-3.5">
                          <div className="flex items-center">
                            <div aria-hidden="true" className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 flex items-center justify-center font-bold text-xs mr-3 shrink-0">
                              {user.name.charAt(0)}
                            </div>
                            {/* Phase 3 Step 8 (item 4): no database id on screen; the email names the account. */}
                            <p className="font-bold text-slate-900 dark:text-white text-sm">{user.name}</p>
                          </div>
                        </td>
                        <td className="px-6 py-3.5 font-medium text-slate-600 dark:text-slate-300 text-xs">
                          <span className="flex items-center min-w-0">
                            <Mail size={13} className="mr-2 shrink-0 text-slate-500" aria-hidden="true" /> <span className="break-all">{user.email}</span>
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-center">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            <Shield size={11} className="mr-1 text-blue-500" /> {user.role}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-center">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${
                            user.status === 'Active' 
                              ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20' 
                              : 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20'
                          }`}>
                            {user.status === 'Active' ? <ShieldCheck size={11} className="mr-1" /> : null}
                            {user.status}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-right relative">
                          <button
                            type="button"
                            data-testid={`users-actions-${user._id}`}
                            onClick={() => toggleDropdown(user._id)}
                            disabled={!manage.allowed}
                            aria-label={`Account actions for ${user.name}`}
                            aria-expanded={activeDropdown === user._id}
                            {...blockedBy(manage, MANAGE_NOTE_ID)}
                            className="text-slate-500 enabled:hover:text-blue-600 dark:enabled:hover:text-blue-400 p-1.5 rounded-lg enabled:hover:bg-slate-100 dark:enabled:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                          >
                            <MoreVertical size={16} aria-hidden="true" />
                          </button>
                          {activeDropdown === user._id && manage.allowed && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => setActiveDropdown(null)}></div>
                              <div className={`absolute right-6 ${isOwnActiveAccount(user) ? 'w-64' : 'w-44'} bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden text-left animate-in fade-in zoom-in-95 duration-150 ${
                                isNearBottom ? 'bottom-8 origin-bottom-right' : 'top-9 origin-top-right'
                              }`}>
                                <button
                                  type="button"
                                  data-testid={`users-edit-${user._id}`}
                                  onClick={() => openEditModal(user)}
                                  className="w-full px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5 flex items-center cursor-pointer"
                                >
                                  <Edit size={14} className="mr-2" /> Edit Permissions
                                </button>
                                <button
                                  type="button"
                                  data-testid={`users-lock-${user._id}`}
                                  onClick={() => handleToggleLock(user)}
                                  disabled={isOwnActiveAccount(user)}
                                  {...(isOwnActiveAccount(user) ? { title: OWN_LOCK_REASON, 'aria-describedby': `users-lock-reason-${user._id}` } : {})}
                                  className="w-full px-4 py-2 text-xs font-medium text-red-600 dark:text-red-400 enabled:hover:bg-red-50 dark:enabled:hover:bg-red-500/10 flex items-center border-t border-slate-100 dark:border-slate-800/60 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                  <Ban size={14} className="mr-2" /> {user.status === 'Active' ? 'Lock Account' : 'Reactivate User'}
                                </button>
                                {isOwnActiveAccount(user) && (
                                  <p id={`users-lock-reason-${user._id}`} data-testid={`users-lock-reason-${user._id}`} className="px-4 pb-2.5 text-[11px] leading-snug whitespace-normal text-slate-600 dark:text-slate-400">
                                    {OWN_LOCK_REASON}
                                  </p>
                                )}
                              </div>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* FOOTER */}
        <div className="bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800/60 px-6 py-3.5 flex items-center justify-between">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Showing <span className="font-bold text-slate-700 dark:text-slate-300">{rangeLabel}</span> of {filteredUsers.length} {filteredUsers.length === 1 ? 'account' : 'accounts'}
          </p>
          <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Account pages" />
        </div>
      </div>

      {/* CREATE / EDIT USER MODAL */}
      {(isAddModalOpen || isEditModalOpen) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center">
              <div>
                <h3 className="text-lg font-black text-slate-800 dark:text-white tracking-wide">
                  {isEditModalOpen ? 'Edit Institutional Permissions' : 'Create User Account'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {isEditModalOpen ? `Editing ${activeUser?.name}` : 'Create an institutional account with specific system privileges.'}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close the account form without saving"
                onClick={() => { setIsAddModalOpen(false); setIsEditModalOpen(false); }}
                className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {validationError && (
              <div role="alert" data-testid="user-form-error" className="mx-6 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400">
                <AlertCircle size={16} className="mr-2 shrink-0" aria-hidden="true" /> {validationError}
              </div>
            )}
            
            <form onSubmit={handleSaveUser} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="user-name" className="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wider">Full Name *</label>
                  <input
                    id="user-name"
                    data-testid="user-name"
                    required
                    type="text"
                    value={formData.name} 
                    onChange={e => setFormData({...formData, name: e.target.value})} 
                    disabled={isSubmitting} 
                    placeholder="e.g. Dr. Juan Dela Cruz"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50" 
                  />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="user-email" className="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wider">Institutional Email *</label>
                  <input
                    id="user-email"
                    data-testid="user-email"
                    required
                    type="email"
                    value={formData.email} 
                    onChange={e => setFormData({...formData, email: e.target.value})} 
                    disabled={isSubmitting} 
                    placeholder="e.g. person@example.test"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50" 
                  />
                </div>

                <div className="col-span-2">
                  <label htmlFor="user-title" className="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wider">Title</label>
                  <input
                    id="user-title"
                    data-testid="user-title"
                    type="text"
                    value={formData.title}
                    onChange={e => setFormData({...formData, title: e.target.value})}
                    disabled={isSubmitting}
                    placeholder="e.g. Dean, College of Computer Studies"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50"
                  />
                </div>

                {(
                  <div className="col-span-2">
                    <label htmlFor="user-password" className="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wider">{activeUser ? 'New password (leave empty to keep it)' : 'Initial Password (Minimum 8 Characters) *'}</label>
                    <div className="relative">
                      <input
                        id="user-password"
                        data-testid="user-password"
                        required={!activeUser}
                        autoComplete="new-password"
                        aria-invalid={Boolean(fieldErrors.password)}
                        type={showPassword ? 'text' : 'password'}
                        value={formData.password} 
                        onChange={e => setFormData({...formData, password: e.target.value})} 
                        disabled={isSubmitting} 
                        placeholder="At least 8 characters"
                        className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 pl-3.5 pr-10 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50" 
                      />
                      <button
                        type="button"
                        data-testid="user-show-password"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                        aria-pressed={showPassword}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300 cursor-pointer"
                      >
                        {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                      </button>
                    </div>
                    {fieldErrors.password && <p role="alert" data-testid="user-password-error" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.password}</p>}
                  </div>
                )}

                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="user-role" className="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wider">Role *</label>
                  <Select
                    id="user-role"
                    data-testid="user-role"
                    required
                    value={formData.role}
                    onChange={e => setFormData({...formData, role: e.target.value})}
                    disabled={isSubmitting}
                    aria-invalid={Boolean(fieldErrors.role)}
                    aria-describedby={fieldErrors.role ? 'user-role-error user-role-help' : 'user-role-help'}
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold"
                  >
                    {/* The roles an account may have: the permission map's ROLES (the User model's). */}
                    {formData.role && !ROLES.includes(formData.role) && (
                      <option value={formData.role} disabled>{formData.role} (no longer a role: choose another)</option>
                    )}
                    {ROLES.map(role => <option key={role} value={role}>{role}</option>)}
                  </Select>
                  {fieldErrors.role && <p id="user-role-error" role="alert" data-testid="user-role-error" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.role}</p>}
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="user-status" className="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wider">Account Status *</label>
                  <Select
                    id="user-status"
                    data-testid="user-status"
                    required
                    value={formData.status}
                    onChange={e => setFormData({...formData, status: e.target.value})}
                    disabled={isSubmitting || isOwnActiveAccount(activeUser)}
                    aria-invalid={Boolean(fieldErrors.status)}
                    aria-describedby={[fieldErrors.status && 'user-status-error', isOwnActiveAccount(activeUser) && 'user-status-reason'].filter(Boolean).join(' ') || undefined}
                    {...(isOwnActiveAccount(activeUser) ? { title: OWN_LOCK_REASON } : {})}
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50"
                  >
                    <option value="Active">Active</option>
                    <option value="Locked">Locked</option>
                  </Select>
                  {fieldErrors.status && <p id="user-status-error" role="alert" data-testid="user-status-error" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.status}</p>}
                  {isOwnActiveAccount(activeUser) && <p id="user-status-reason" data-testid="user-status-reason" className="mt-1 text-[11px] leading-snug text-slate-600 dark:text-slate-400">{OWN_LOCK_REASON}</p>}
                </div>
                {/* What the chosen role may do, from the permission map. */}
                <p id="user-role-help" data-testid="user-role-help" className="col-span-2 text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                  {ROLE_SUMMARY[formData.role] && <span data-testid="user-role-summary" className="block font-bold text-slate-700 dark:text-slate-300">{ROLE_SUMMARY[formData.role]}</span>}{ROLE_SUMMARY[formData.role] && " "}
                  {roleAbilitiesText(formData.role)}
                </p>
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800/60 flex justify-end gap-3 bg-slate-50 dark:bg-[#1a1a1c]">
                <button
                  type="button"
                  onClick={() => { setIsAddModalOpen(false); setIsEditModalOpen(false); }}
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="user-submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-md shadow-blue-900/20 flex items-center disabled:opacity-70 cursor-pointer"
                >
                  {isSubmitting ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                  {isSubmitting ? 'Saving...' : isEditModalOpen ? 'Save Changes' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <div role="status" data-testid="users-toast" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="w-7 h-7 rounded-lg bg-blue-500/20 dark:bg-blue-500/15 flex items-center justify-center text-blue-500 shrink-0">
            <CheckCircle2 size={16} />
          </div>
          <span className="text-xs font-bold tracking-wide">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => setToast(null)}
            className="ml-2 text-slate-400 dark:text-slate-600 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}