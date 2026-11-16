import { useState, useEffect, useRef } from 'react';
import { Search, Plus, Ban, DoorOpen, Monitor, Loader2, CheckCircle2, X, ShieldCheck, AlertCircle, AlertOctagon } from 'lucide-react';
import api from '../../services/api';
import usePagination from '../../hooks/usePagination';
import useEscapeKey from '../../hooks/useEscapeKey';
import TablePagination from '../../components/ui/TablePagination';
import RowActions from '../../components/ui/RowActions';
import FilterPopover, { FilterSelect } from '../../components/ui/FilterPopover';
import { disabledCellClass, disabledBadgeClass } from '../../components/ui/tableStyles';
import TimeWindowsEditor from '../../components/ui/TimeWindowsEditor';
import SortableHeader from '../../components/ui/SortableHeader';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import PageHeader from '../../components/layout/PageHeader';
import PermissionNote from '../../components/ui/PermissionNote';
import useSort from '../../hooks/useSort';
import usePolicy from '../../hooks/usePolicy';
import useConfirmDisable from '../../hooks/useConfirmDisable';
import usePermission, { blockedBy } from '../../hooks/usePermission';
import { undoDisable } from '../../utils/recordToggle';
import Select from '../../components/ui/Select';

// The visible reason (Phase 3 Step 6) the page's write controls point at while the role may not use them.
const EDIT_NOTE_ID = 'rooms-permission-note';
import { DAY_NAMES, gridTimes, gridOrigin, toMinutes, fromMinutes } from '../../utils/timeGrid';
import { availabilityWords } from '../../utils/scheduleDisplay';

// Operational state is a strict boolean: Active (isActive=true) or Disabled (isActive=false).
// The legacy "Maintenance" status string has been retired; the Facility schema only stores isActive.
// Status is never edited through the form: new rooms are created Active and are toggled from the table.
// Capacity and building are optional; availability empty = usable whenever the policy allows.
const DEFAULT_FORM = {
  roomName: '',
  roomType: 'LEC',
  capacity: '',
  building: '',
  availability: []
};

const SORT_GETTERS = {
  roomName: r => r.roomName,
  type: r => r.type,
  capacity: r => (Number.isFinite(r.capacity) ? r.capacity : null),
  building: r => r.building || null
};

// "Whenever classes run" or "Tue 1:00 PM–5:00 PM · Thu 1:00 PM–5:00 PM" (utils/scheduleDisplay.js: the
// same words "Fill TBA rooms" uses for a borrowed room's free times).
const availabilitySummary = (room) => availabilityWords(room.availability);

// Table filters. '' means "All" for a key; the visible list is search AND type AND status.
const DEFAULT_FILTERS = {
  type: '',
  status: ''
};

const ROOM_TYPE_OPTIONS = [
  { value: 'LEC', label: 'Lecture (LEC)' },
  { value: 'LAB', label: 'Laboratory (LAB)' }
];

// Status values map onto the boolean isActive flag; labels match the table's status badge.
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' }
];

const FETCH_ERROR_MESSAGE = 'The rooms could not be loaded. Check your connection, then select Retry Request.';

// Single read path for the inventory. The mount effect, the error-state retry and every successful
// mutation all go through it, so the table always reflects what Atlas actually persisted.
const fetchRoomList = async () => {
  const res = await api.get('/facilities');
  return Array.isArray(res.data) ? res.data : [];
};

export default function RoomManager() {
  const { policy } = usePolicy();
  // Adding, editing, disabling and enabling rooms: the permission map's data.edit.
  const edit = usePermission('data.edit');
  // Times offered for availability windows: the whole scheduling day of the policy.
  const windowTimes = policy
    ? gridTimes(gridOrigin(policy), fromMinutes(Math.max(toMinutes(policy.dayEnd), toMinutes(policy.saturdayOverflow.end))), policy.slotMinutes)
    : [];
  const [fieldErrors, setFieldErrors] = useState({});
  const [roomsList, setRoomsList] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState(null);
  const [pendingToggleIds, setPendingToggleIds] = useState(() => new Set());
  const [formData, setFormData] = useState(DEFAULT_FORM);
  const [validationError, setValidationError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  // Footer live indicator: amber while a post-mutation re-sync is in flight, and the wall-clock
  // time of the last fetch that Atlas actually answered (mount load, retry, or re-sync).
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  // Monotonic ticket for list refetches: a slower, older response must never overwrite a newer one.
  const syncSeq = useRef(0);

  // Auto-dismiss is scoped to the toast it was scheduled for: a timer left over from an earlier,
  // slower flow (e.g. a save whose re-sync is still in flight) must never clear a newer message.
  // tone 'error' shows a failure; `undo` adds an Undo button (and a longer time to press it).
  const showToast = (message, tone = 'success', undo = null) => {
    const entry = { message, tone, undo };
    setToast(entry);
    setTimeout(() => setToast(current => (current === entry ? null : current)), undo ? 10000 : 4000);
  };

  // The one full loader, with visible loading/error state. Used by the mount effect and by the
  // error-state "Retry Request" button. Only the latest refetch may settle the loading flag: a
  // superseded load (StrictMode double-mount, or a mutation re-sync that overtook it) must not
  // clear the spinner over an empty list, and the newer request releases it instead.
  const loadRooms = async () => {
    const seq = ++syncSeq.current;
    setIsLoading(true);
    setErrorMessage('');
    try {
      const rooms = await fetchRoomList();
      if (seq !== syncSeq.current) return;
      setRoomsList(rooms);
      setLastSyncedAt(new Date());
    } catch (err) {
      if (seq !== syncSeq.current) return;
      console.warn('[Facilities] Atlas fetch failed:', err.message);
      setRoomsList([]);
      setErrorMessage(err.response?.data?.message || FETCH_ERROR_MESSAGE);
    } finally {
      if (seq === syncSeq.current) {
        setIsLoading(false);
        // A full load that overtook an in-flight re-sync now owns the syncing flag too, so the
        // superseded re-sync (which is barred from touching state) cannot leave it stuck amber.
        setIsSyncing(false);
      }
    }
  };

  useEffect(() => {
    // Fetch-on-mount through the same loader as "Retry Request". The loader flips the loading /
    // error flags before it awaits, which the compiler lint reads as derived state; here it is the
    // intended initial fetch, so the rule is scoped off for this one call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRooms();
  }, []);

  // Silent revalidation after every successful mutation. The optimistic local update has already
  // rendered; this swaps it for Atlas truth. A failed re-fetch keeps the optimistic state and only
  // surfaces a toast, never an error state or a thrown rejection. A response that has been
  // superseded by a newer refetch is dropped so a stale list never reverts a later toggle.
  const syncRoomsFromAtlas = async () => {
    const seq = ++syncSeq.current;
    setIsSyncing(true);
    try {
      const rooms = await fetchRoomList();
      if (seq !== syncSeq.current) return;
      setRoomsList(rooms);
      setLastSyncedAt(new Date());
      // Atlas answered, so a stale gateway error must not keep hiding the fresh table.
      setErrorMessage('');
    } catch (err) {
      if (seq !== syncSeq.current) return;
      console.warn('[Facilities] Post-mutation re-sync failed:', err.message);
      showToast('Saved, but the table could not be read again. It shows your change and refreshes on the next one.');
    } finally {
      // Only the latest refetch may settle the flags: an older completion must not clear a newer
      // sync's amber indicator. If this re-sync overtook an in-flight full load, it now owns the
      // loading flag as well.
      if (seq === syncSeq.current) {
        setIsSyncing(false);
        setIsLoading(false);
      }
    }
  };

  const openAddModal = () => {
    if (!edit.allowed) return;
    setEditingRoom(null);
    setFormData(DEFAULT_FORM);
    setValidationError('');
    setFieldErrors({});
    setIsModalOpen(true);
  };

  const openEditModal = (room) => {
    if (!edit.allowed) return;
    setEditingRoom(room);
    setFormData({
      roomName: room.roomName,
      roomType: room.type || 'LEC',
      capacity: Number.isFinite(room.capacity) ? String(room.capacity) : '',
      building: room.building || '',
      availability: (room.availability || []).map(w => ({ day: w.day, start: w.start, end: w.end }))
    });
    setValidationError('');
    setFieldErrors({});
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingRoom(null);
    setFormData(DEFAULT_FORM);
    setValidationError('');
    setFieldErrors({});
  };

  useEscapeKey(isModalOpen, closeModal, isSubmitting);

  const handleSaveRoom = async (e) => {
    e.preventDefault();
    setValidationError('');

    setFieldErrors({});
    const cleanName = formData.roomName.trim().toUpperCase();

    if (!cleanName) {
      setFieldErrors({ roomName: 'Enter the room name.' });
      return;
    }

    setIsSubmitting(true);

    // Status is not a form field: creation always yields an Active room, and editing preserves
    // whatever state the table toggle last set. Blank capacity / building mean "not recorded".
    const payload = {
      roomName: cleanName,
      type: formData.roomType,
      capacity: String(formData.capacity).trim() === '' ? null : Number(formData.capacity),
      building: formData.building.trim() || null,
      availability: formData.availability,
      // Creation is always active; an edit omits the key so Atlas keeps the persisted state.
      ...(editingRoom ? {} : { isActive: true })
    };

    let saved = false;
    try {
      if (editingRoom) {
        const res = await api.put(`/facilities/${editingRoom._id}`, payload);
        setRoomsList(prev => prev.map(r => r._id === editingRoom._id ? res.data : r));
        showToast(`${cleanName} updated.`);
      } else {
        const res = await api.post('/facilities', payload);
        setRoomsList(prev => [res.data, ...prev]);
        showToast(`${cleanName} added to the rooms.`);
      }
      saved = true;
      closeModal();
    } catch (err) {
      // Field errors go next to their fields; anything else goes in the banner. The form keeps
      // everything that was typed.
      const errors = err.response?.data?.errors;
      if (Array.isArray(errors) && errors.length) {
        setFieldErrors(Object.fromEntries(errors.map(e => [e.field, e.message])));
        setValidationError('The room was not saved. Fix the fields marked below.');
      } else {
        setValidationError(err.response?.data?.message || `The room could not be saved (${err.message}). Your entries are still here; try again.`);
      }
    } finally {
      // The submitting flag is owned by this request alone and released the moment it settles.
      // Nothing after this point touches it, so a slow background re-sync from this save can
      // never re-enable (or clobber) a newer submission from a re-opened modal.
      setIsSubmitting(false);
    }

    // Silent revalidation runs outside the submitting lifecycle: the dialog is already closed and
    // the flag already released, so a slow gateway or timeout here never gates the next form.
    if (saved) await syncRoomsFromAtlas();
  };

  // PATCH /facilities/:id/toggle flips the room's status; resolves its new state (or throws). The row's
  // button shows a spinner meanwhile.
  const toggleRoom = async (room) => {
    setPendingToggleIds(prev => new Set(prev).add(room._id));
    try {
      const res = await api.patch(`/facilities/${room._id}/toggle`);
      const newIsActive = Boolean(res.data.isActive);
      setRoomsList(prev => prev.map(r => r._id === room._id ? { ...r, isActive: newIsActive } : r));
      return newIsActive;
    } finally {
      setPendingToggleIds(prev => {
        const next = new Set(prev);
        next.delete(room._id);
        return next;
      });
    }
  };
  const statusText = (room, isActive) => (isActive
    ? `${room.roomName} enabled: the scheduler may use it again.`
    : `${room.roomName} disabled: it is no longer offered to the scheduler.`);

  // Undo of a disable: the room is enabled again only if it is still disabled (utils/recordToggle.js).
  const undoRoomDisable = async (room) => {
    setPendingToggleIds(prev => new Set(prev).add(room._id));
    const result = await undoDisable({ listPath: '/facilities', togglePath: `/facilities/${room._id}/toggle`, id: room._id, name: room.roomName });
    setPendingToggleIds(prev => {
      const next = new Set(prev);
      next.delete(room._id);
      return next;
    });
    if (typeof result.isActive === 'boolean') setRoomsList(prev => prev.map(r => r._id === room._id ? { ...r, isActive: result.isActive } : r));
    showToast(result.message, result.tone);
    await syncRoomsFromAtlas();
  };

  // Disabling asks first (audit X6); the message that follows offers Undo.
  const disableQuestion = useConfirmDisable(async (room) => {
    try {
      const isActive = await toggleRoom(room);
      showToast(statusText(room, isActive), 'success', isActive ? null : () => undoRoomDisable(room));
      syncRoomsFromAtlas();
      return '';
    } catch (err) {
      console.warn('[Facilities] Status toggle failed:', err.message);
      return `${room.roomName} was not disabled (${err.response?.data?.message || err.message}). Nothing changed: try again, or cancel.`;
    }
  });

  // The row's Disable asks first; Enable acts at once.
  const handleToggleStatus = async (room, e) => {
    e?.stopPropagation?.();
    if (!edit.allowed || pendingToggleIds.has(room._id)) return;
    if (room.isActive) {
      disableQuestion.ask(room);
      return;
    }
    try {
      showToast(statusText(room, await toggleRoom(room)));
      await syncRoomsFromAtlas();
    } catch (err) {
      console.warn('[Facilities] Status toggle failed:', err.message);
      showToast(`${room.roomName}: the status could not be changed (${err.response?.data?.message || err.message}). Nothing changed; try again.`, 'error');
    }
  };

  // Search, filters, pagination. A row is shown only when it matches the search text AND every
  // active filter; the page resets to 1 whenever any of those inputs change.
  const normalizedQuery = searchQuery.toLowerCase();
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const filteredRooms = roomsList.filter(room => {
    const matchesSearch = !normalizedQuery
      || room.roomName?.toLowerCase().includes(normalizedQuery)
      || room.type?.toLowerCase().includes(normalizedQuery)
      || room.building?.toLowerCase().includes(normalizedQuery);
    const matchesType = !filters.type || room.type === filters.type;
    const matchesStatus = !filters.status
      || (filters.status === 'active' ? Boolean(room.isActive) : !room.isActive);
    return matchesSearch && matchesType && matchesStatus;
  });

  const { sorted: sortedRooms, sort, toggle: toggleSort } = useSort(filteredRooms, SORT_GETTERS, 'roomName');

  const {
    currentPage,
    totalPages,
    totalItems,
    pageItems,
    rangeLabel,
    setPage,
    resetPage
  } = usePagination(sortedRooms, 25);

  const handleSearchChange = (value) => {
    setSearchQuery(value);
    resetPage();
  };

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    resetPage();
  };

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    resetPage();
  };

  const isFilteredView = Boolean(searchQuery) || activeFilterCount > 0;

  return (
    <div className="animate-in fade-in duration-300 relative">
      {/* No overflow-hidden on the card: the Filters popover is absolutely positioned inside the
          header and must be free to extend over the table. Corners are rounded on the header
          and footer themselves instead. */}
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg flex flex-col">

        {/* HEADER AREA */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5 rounded-t-3xl">
          <PageHeader pageKey="rooms" />

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                placeholder="Search rooms or buildings..." aria-label="Search rooms" data-testid="room-search" 
                value={searchQuery} 
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-emerald-500 transition-colors text-slate-900 dark:text-white"
              />
            </div>
            <FilterPopover
              title="Filter Rooms"
              ariaLabel="Room filters"
              accent="emerald"
              activeCount={activeFilterCount}
              summary={`${filteredRooms.length} of ${roomsList.length} shown`}
              onClear={clearFilters}
            >
              <FilterSelect
                label="Room Type"
                value={filters.type}
                onChange={(value) => handleFilterChange('type', value)}
                options={ROOM_TYPE_OPTIONS}
                allLabel="All Types"
                accent="emerald"
              />
              <FilterSelect
                label="Status"
                value={filters.status}
                onChange={(value) => handleFilterChange('status', value)}
                options={STATUS_OPTIONS}
                allLabel="All Statuses"
                accent="emerald"
              />
            </FilterPopover>
            <button
              type="button"
              data-testid="room-add"
              onClick={openAddModal}
              disabled={!edit.allowed}
              {...blockedBy(edit, EDIT_NOTE_ID)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center transition-colors shadow-lg shadow-emerald-900/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-600"
            >
              <Plus size={16} className="mr-2" /> Add Room
            </button>
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {!edit.allowed && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={EDIT_NOTE_ID} permission={edit} lead="You can view the rooms." />
          </div>
        )}

        {/* TABLE AREA: min-height keeps a 0- or 1-row table tall enough that the absolutely
            positioned Filters popover from the header can render fully over it. */}
        <div className="relative min-h-[400px] overflow-visible">
          {isLoading ? (
            <div className="p-16 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400 gap-3">
              <Loader2 size={36} className="animate-spin text-emerald-500" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading rooms…</p>
            </div>
          ) : errorMessage ? (
            <div className="p-12 text-center max-w-md mx-auto my-8">
              <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">Rooms could not be loaded</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">{errorMessage}</p>
              <button
                type="button"
                onClick={loadRooms}
                className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition-colors cursor-pointer"
              >
                Retry Request
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left text-sm">
              <thead className="bg-white dark:bg-[#18181b] border-b border-slate-200 dark:border-slate-800/60 text-slate-500 dark:text-slate-400">
                <tr>
                  <SortableHeader label="Room" sortKey="roomName" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Type" sortKey="type" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Capacity" sortKey="capacity" sort={sort} onSort={toggleSort} className="text-center" align="center" />
                  <SortableHeader label="Building" sortKey="building" sort={sort} onSort={toggleSort} />
                  <th scope="col" className="px-6 py-4 font-bold text-xs">Available</th>
                  <th scope="col" className="px-6 py-4 font-bold text-xs text-center">Status</th>
                  <th scope="col" className="px-6 py-4 font-bold text-xs text-right sticky right-0 bg-white dark:bg-[#18181b]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {filteredRooms.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-slate-500 dark:text-slate-400">
                      <DoorOpen size={32} className="mx-auto mb-2 opacity-30 text-emerald-500" />
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                        {isFilteredView ? 'No Matching Facilities Found' : 'No Facilities Registered'}
                      </p>
                      <p className="text-xs mt-1">
                        {isFilteredView
                          ? 'Try adjusting your search or clearing the active filters.'
                          : edit.allowed ? 'Select "Add Room" above to add the first room.' : edit.reason}
                      </p>
                    </td>
                  </tr>
                ) : (
                  pageItems.map((room) => {
                    const isInactive = room.isActive === false;
                    const dataCellClass = `px-6 py-3.5 ${isInactive ? disabledCellClass : ''}`;

                    return (
                      <tr key={room._id} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors group text-slate-700 dark:text-slate-300">
                        <td className={dataCellClass}>
                          <p className="font-bold text-slate-900 dark:text-white whitespace-nowrap">{room.roomName}</p>
                        </td>
                        <td className={dataCellClass}>
                          <div className="inline-flex items-center whitespace-nowrap text-xs font-bold px-2.5 py-0.5 rounded-md border border-slate-200 dark:border-slate-700">
                            {room.type === 'LAB' ? (
                              <>
                                <Monitor size={13} className="mr-1.5 text-emerald-500" />
                                <span className="text-emerald-700 dark:text-emerald-400">Laboratory (LAB)</span>
                              </>
                            ) : (
                              <>
                                <DoorOpen size={13} className="mr-1.5 text-blue-500" />
                                <span className="text-blue-700 dark:text-blue-400">Lecture (LEC)</span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className={`${dataCellClass} text-center text-xs font-bold`}>
                          {Number.isFinite(room.capacity) ? room.capacity : <span className="text-slate-500 dark:text-slate-400" title="Not recorded">—</span>}
                        </td>
                        <td className={`${dataCellClass} text-xs`}>
                          {room.building || <span className="text-slate-500 dark:text-slate-400" title="Not recorded">—</span>}
                        </td>
                        <td className={`${dataCellClass} text-xs min-w-40 max-w-72`}>
                          {availabilitySummary(room)}
                        </td>
                        <td className={`${dataCellClass} text-center`}>
                          {room.isActive ? (
                            <span className="inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 border border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20">
                              <ShieldCheck size={11} className="mr-1" /> Active
                            </span>
                          ) : (
                            <span className={disabledBadgeClass}>
                              <Ban size={11} className="mr-1" /> Disabled
                            </span>
                          )}
                        </td>
                        <td className={`px-6 py-3.5 text-right sticky right-0 ${isInactive ? 'bg-slate-50 dark:bg-[#1c1c1f]' : 'bg-white dark:bg-[#18181b]'}`}>
                          <RowActions
                            isActive={room.isActive}
                            onEdit={() => openEditModal(room)}
                            onToggle={(e) => handleToggleStatus(room, e)}
                            isPending={pendingToggleIds.has(room._id)}
                            name={room.roomName}
                            blockedReason={edit.reason}
                            reasonId={EDIT_NOTE_ID}
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {/* FOOTER: range, pagination, live indicator (bottom-right) */}
        <div className="bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800/60 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-b-3xl">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Showing <span className="font-bold text-slate-700 dark:text-slate-300">{rangeLabel}</span> of{' '}
            <span className="font-bold text-slate-700 dark:text-slate-300">{totalItems}</span> rooms
          </p>
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
            <TablePagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setPage}
              label="Room inventory pages"
              isSyncing={isSyncing}
              hasError={Boolean(errorMessage)}
              lastSyncedAt={lastSyncedAt}
            />
          </div>
        </div>
      </div>

      {/* MODAL */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onMouseDown={(event) => {
            // Only a press that starts on the backdrop itself dismisses; a drag that begins inside
            // the card (e.g. selecting text in an input) and ends outside must not close the form.
            if (event.target !== event.currentTarget || isSubmitting) return;
            closeModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-modal-title"
            className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200"
          >
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center">
              <div>
                <h3 id="room-modal-title" className="text-lg font-black text-slate-800 dark:text-white tracking-wide">
                  {editingRoom ? 'Edit Facility Details' : 'Add New Room'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {editingRoom ? `Change the details of ${editingRoom.roomName}.` : 'A room the scheduler can place classes in.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={isSubmitting}
                aria-label="Close dialog"
                className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded-lg disabled:opacity-50 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {validationError && (
              <div className="mx-6 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400">
                <AlertCircle size={16} className="mr-2 shrink-0" /> {validationError}
              </div>
            )}
            
            <form onSubmit={handleSaveRoom} noValidate className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label htmlFor="room-name" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Room name <span aria-hidden="true">*</span><span className="sr-only">(required)</span></label>
                  <input
                    id="room-name"
                    data-testid="room-name"
                    required
                    aria-invalid={Boolean(fieldErrors.roomName)}
                    aria-describedby={fieldErrors.roomName ? 'room-name-error' : undefined}
                    type="text"
                    value={formData.roomName}
                    onChange={e => setFormData({ ...formData, roomName: e.target.value })}
                    disabled={isSubmitting}
                    placeholder="e.g. ROOM 47"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-emerald-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold"
                  />
                  {fieldErrors.roomName && <p id="room-name-error" role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.roomName}</p>}
                </div>

                <div className="col-span-2">
                  <label htmlFor="room-type" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Room type <span aria-hidden="true">*</span><span className="sr-only">(required)</span></label>
                  <Select
                    id="room-type"
                    data-testid="room-type"
                    value={formData.roomType}
                    onChange={e => setFormData({ ...formData, roomType: e.target.value })}
                    disabled={isSubmitting}
                    aria-describedby="room-type-help"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-emerald-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold"
                  >
                    <option value="LEC">Lecture room (LEC)</option>
                    <option value="LAB">Laboratory (LAB)</option>
                  </Select>
                  <p id="room-type-help" className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">LAB classes use LAB rooms only. Major lectures use LEC rooms (LAB rooms as the Scheduling Policy allows).</p>
                  {fieldErrors.type && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.type}</p>}
                </div>

                <div>
                  <label htmlFor="room-capacity" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Capacity (optional)</label>
                  <input
                    id="room-capacity"
                    data-testid="room-capacity"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="300"
                    step="1"
                    value={formData.capacity}
                    onChange={e => setFormData({ ...formData, capacity: e.target.value })}
                    disabled={isSubmitting}
                    aria-invalid={Boolean(fieldErrors.capacity)}
                    aria-describedby="room-capacity-help"
                    placeholder="Not recorded"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-emerald-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold"
                  />
                  <p id="room-capacity-help" className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Seats, for information. The scheduler ignores it unless the Scheduling Policy turns capacity checking on.</p>
                  {fieldErrors.capacity && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.capacity}</p>}
                </div>

                <div>
                  <label htmlFor="room-building" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Building (optional)</label>
                  <input
                    id="room-building"
                    data-testid="room-building"
                    type="text"
                    maxLength={80}
                    value={formData.building}
                    onChange={e => setFormData({ ...formData, building: e.target.value })}
                    disabled={isSubmitting}
                    aria-describedby="room-building-help"
                    placeholder="Not recorded"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-emerald-500 text-slate-900 dark:text-white disabled:opacity-50"
                  />
                  <p id="room-building-help" className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Where the room is, for information.</p>
                </div>

                <TimeWindowsEditor
                  label="Availability (optional)"
                  help="Leave empty if the room can be used whenever classes run. For a room borrowed from another department, add the windows when CCS may use it: the scheduler then uses it only in those windows."
                  testIdPrefix="room-availability"
                  fieldPrefix="availability"
                  windows={formData.availability}
                  onChange={availability => setFormData(prev => ({ ...prev, availability }))}
                  days={DAY_NAMES.filter(d => d !== 'Sunday')}
                  times={windowTimes}
                  errors={fieldErrors}
                  disabled={isSubmitting || !policy}
                  addLabel="Add an availability window"
                  emptyText="No windows: available whenever classes run."
                />
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800/60 flex justify-end gap-3 bg-slate-50 dark:bg-[#1a1a1c]">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="room-submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors shadow-md shadow-emerald-900/20 flex items-center disabled:opacity-70 cursor-pointer"
                >
                  {isSubmitting ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                  {isSubmitting ? 'Saving...' : editingRoom ? 'Save Changes' : 'Create Room'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DISABLE CONFIRMATION */}
      {disableQuestion.target && (
        <ConfirmDialog
          testId="disable-confirm"
          title={`Disable ${disableQuestion.target.roomName}?`}
          keepLabel="Cancel"
          confirmLabel={`Disable ${disableQuestion.target.roomName}`}
          busyLabel="Disabling…"
          onKeep={disableQuestion.keep}
          onConfirm={disableQuestion.confirm}
          busy={disableQuestion.busy}
          error={disableQuestion.error}
          tone="red"
          icon={Ban}
        >
          It is no longer offered to the scheduler. You can enable it again.
        </ConfirmDialog>
      )}

      {/* Toast Notification. The live region stays mounted so every message is announced. */}
      <div role="status" aria-live="polite" className="fixed bottom-6 right-6 z-50">
        {toast && (
          <div data-testid="room-toast" data-tone={toast.tone} className="flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300 max-w-md">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${toast.tone === 'error' ? 'bg-red-500/20 dark:bg-red-500/15 text-red-400 dark:text-red-600' : 'bg-emerald-500/20 dark:bg-emerald-500/15 text-emerald-500'}`}>
              {toast.tone === 'error' ? <AlertCircle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            </div>
            <span data-testid="room-toast-message" className="text-xs font-bold tracking-wide">{toast.message}</span>
            {toast.undo && (
              <button type="button" data-testid="room-undo" onClick={() => { const undo = toast.undo; setToast(null); undo(); }} className="ml-1 shrink-0 px-2.5 py-1 rounded-lg text-xs font-black text-emerald-300 dark:text-emerald-700 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                Undo
              </button>
            )}
            <button type="button" aria-label="Dismiss message" onClick={() => setToast(null)} className="ml-1 text-slate-400 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}