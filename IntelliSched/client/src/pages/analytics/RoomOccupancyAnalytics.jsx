import { useState } from 'react';
import { DoorOpen, Search, Download, Monitor, TrendingUp, Loader2, CheckCircle2, X, Building2, AlertTriangle, Clock } from 'lucide-react';

// Phase 1 Step 9: the invented sample rows are gone (no dummy numbers). This page stays hidden from
// the navigation; Phase 3 fills it from the saved schedule's room program.
const DUMMY_ROOMS = [];

export default function RoomOccupancyAnalytics() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [toast, setToast] = useState(null);

  const roomsWithRate = DUMMY_ROOMS.map(r => ({
    ...r,
    utilization: Math.round((r.hoursUsed / r.maxWeeklyHours) * 100)
  }));

  const filteredRooms = roomsWithRate.filter((room) =>
    room.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    room.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
    room.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
    room.status.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalFacilities = DUMMY_ROOMS.length;
  const avgUtilization = (roomsWithRate.reduce((sum, r) => sum + r.utilization, 0) / (totalFacilities || 1)).toFixed(1);
  const highUsageCount = roomsWithRate.filter(r => r.utilization >= 75).length;

  const handleExport = async () => {
    setIsExporting(true);

    const exportPayload = {
      reportType: 'ROOM_OCCUPANCY_AND_UTILIZATION_AUDIT',
      academicTerm: '1st Sem 2026-2027',
      generatedAt: new Date().toISOString(),
      roomCount: filteredRooms.length,
      dataset: filteredRooms.map(r => ({
        roomId: r.id,
        roomName: r.name,
        classification: r.type,
        seatingCapacity: r.capacity,
        weeklyHoursOccupied: r.hoursUsed,
        effectiveCapacityHours: r.maxWeeklyHours,
        utilizationRate: `${r.utilization}%`,
        complianceStatus: r.status
      }))
    };

    setTimeout(() => {
      const element = document.createElement('a');
      const file = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      element.href = URL.createObjectURL(file);
      element.download = `LSPU_Room_Occupancy_Audit_${Date.now()}.json`;
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);

      setIsExporting(false);
      setToast({ message: "Facility Occupancy & Utilization Audit Report exported successfully." });
      setTimeout(() => setToast(null), 4000);
    }, 1400);
  };

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">
        
        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-slate-500/10 rounded-xl border border-slate-500/20">
              <DoorOpen className="text-slate-600 dark:text-slate-400" size={28} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-wide">Room Occupancy Analytics</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Monitor facility density and lab-to-lecture routing compliance (45 max instructional hrs/wk).
              </p>
            </div>
          </div>
          <button 
            onClick={handleExport}
            disabled={isExporting}
            className="bg-slate-800 hover:bg-slate-900 dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 text-white disabled:opacity-50 px-5 py-2.5 rounded-xl text-sm font-bold flex items-center transition-all shadow-lg cursor-pointer"
          >
            {isExporting ? <Loader2 className="animate-spin mr-2" size={16} /> : <Download size={16} className="mr-2" />}
            {isExporting ? 'Generating Report...' : 'Export Occupancy Report'}
          </button>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        <div className="p-6 md:p-8 bg-slate-50 dark:bg-[#09090b] min-h-125">
          
          {/* Quick Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex items-center shadow-sm">
              <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 rounded-2xl mr-4"><Building2 size={24} /></div>
              <div>
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Active Facilities</p>
                <p className="text-2xl font-black text-slate-800 dark:text-white">{totalFacilities}</p>
              </div>
            </div>
            <div className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex items-center shadow-sm">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-2xl mr-4"><TrendingUp size={24} /></div>
              <div>
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Average Utilization</p>
                <p className="text-2xl font-black text-slate-800 dark:text-white">{avgUtilization}%</p>
              </div>
            </div>
            <div className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex items-center shadow-sm">
              <div className="p-4 bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 rounded-2xl mr-4"><AlertTriangle size={24} /></div>
              <div>
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">High Demand (&ge;75%)</p>
                <p className="text-2xl font-black text-slate-800 dark:text-white">{highUsageCount} Rooms</p>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-[#121212]">
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
                <input 
                  type="text" 
                  placeholder="Search facilities or classifications..." 
                  value={searchQuery} 
                  onChange={(e) => setSearchQuery(e.target.value)} 
                  className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 pl-9 pr-4 text-sm focus:outline-none focus:border-slate-500 text-slate-900 dark:text-white" 
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 flex items-center">
                  <Clock size={13} className="mr-1 text-amber-500" /> Weekly room hours
                </span>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-50 dark:bg-[#1a1a1c] border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <tr>
                    <th className="px-6 py-4 font-bold text-xs">Facility Name</th>
                    <th className="px-6 py-4 font-bold text-xs">Classification</th>
                    <th className="px-6 py-4 font-bold text-xs text-center">Weekly Hours Used</th>
                    <th className="px-6 py-4 font-bold text-xs">Occupancy / Capacity Index</th>
                    <th className="px-6 py-4 font-bold text-xs text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {filteredRooms.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4 font-bold text-slate-800 dark:text-white">
                        {row.name}
                        <span className="text-[10px] font-normal text-slate-500 dark:text-slate-400 block">{row.id} • Capacity {row.capacity} Pax</span>
                      </td>
                      <td className="px-6 py-4 text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center">
                          {row.type === 'Laboratory' ? <Monitor size={14} className="mr-2 text-emerald-500" /> : <DoorOpen size={14} className="mr-2 text-blue-500" />}
                          {row.type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center font-black">{row.hoursUsed} / {row.maxWeeklyHours} hrs</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center">
                          <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 mr-3 max-w-25">
                            <div className={`h-1.5 rounded-full ${row.utilization >= 75 ? 'bg-orange-500' : 'bg-blue-500'}`} style={{ width: `${row.utilization}%` }}></div>
                          </div>
                          <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{row.utilization}%</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                          row.status === 'High Usage'
                            ? 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-500/20'
                            : row.status === 'Optimal'
                            ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20'
                            : 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-400'
                        }`}>
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-4 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="w-8 h-8 rounded-xl bg-slate-500/20 dark:bg-slate-500/15 flex items-center justify-center text-slate-500 dark:text-slate-400 shrink-0">
            <CheckCircle2 size={18} />
          </div>
          <span className="text-sm font-bold tracking-wide">{toast.message}</span>
          <button 
            onClick={() => setToast(null)} 
            className="ml-3 text-slate-400 dark:text-slate-600 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}