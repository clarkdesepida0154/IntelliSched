import { useState } from 'react';
import { LineChart, Search, Filter, Download, Users, Briefcase, TrendingUp, Loader2, CheckCircle2, X, Award } from 'lucide-react';

// Phase 1 Step 9: the invented sample rows are gone (no dummy numbers). This page stays hidden from
// the navigation; Phase 3 fills it from the one load rule (GET /api/schedule/loads).
const DUMMY_WORKLOAD = [];

export default function FacultyWorkloadAnalytics() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [toast, setToast] = useState(null);

  const filteredWorkload = DUMMY_WORKLOAD.filter((row) =>
    row.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    row.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
    row.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
    row.status.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalFacultyCount = DUMMY_WORKLOAD.filter(f => f.status !== 'Inactive').length;
  const avgLoad = (DUMMY_WORKLOAD.filter(f => f.status !== 'Inactive').reduce((sum, f) => sum + f.total, 0) / (totalFacultyCount || 1)).toFixed(1);
  const overloadedCount = DUMMY_WORKLOAD.filter(f => f.status === 'Overloaded').length;

  const handleExport = async () => {
    setIsExporting(true);

    const exportPayload = {
      reportType: 'FACULTY_WORKLOAD_DISTRIBUTION',
      semester: '1st Sem 2026-2027',
      generatedAt: new Date().toISOString(),
      recordCount: filteredWorkload.length,
      dataset: filteredWorkload.map(f => ({
        id: f.id,
        faculty: f.name,
        teachingUnits: f.regLoad,
        ancillaryHours: f.ancLoad,
        totalLoad: f.total,
        maxCapacity: f.maxLoad,
        preparationsCount: f.prepCount,
        complianceStatus: f.status
      }))
    };

    console.log("Generating Official Faculty Workload PDF/Excel Report:", exportPayload);

    setTimeout(() => {
      const element = document.createElement('a');
      const file = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      element.href = URL.createObjectURL(file);
      element.download = `LSPU_Faculty_Workload_Report_${Date.now()}.json`;
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);

      setIsExporting(false);
      setToast({ message: "Faculty Workload Audit Report (SF-029 Data) generated and exported." });
      setTimeout(() => setToast(null), 4000);
    }, 1400);
  };

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">
        
        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-teal-500/10 rounded-xl border border-teal-500/20">
              <LineChart className="text-teal-600 dark:text-teal-400" size={28} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-wide">Faculty Workload Analytics</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Review each professor's teaching hours, preparations and other duties.
              </p>
            </div>
          </div>
          <button 
            onClick={handleExport}
            disabled={isExporting}
            className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center transition-all shadow-lg shadow-teal-900/20 cursor-pointer"
          >
            {isExporting ? <Loader2 className="animate-spin mr-2" size={16} /> : <Download size={16} className="mr-2" />}
            {isExporting ? 'Generating Report...' : 'Export Workload Report'}
          </button>
        </div>

        {/* Brand linear divider */}
        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        <div className="p-6 md:p-8 bg-slate-50 dark:bg-[#09090b]">
          
          {/* Quick Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex items-center shadow-sm">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-2xl mr-4"><Users size={24} /></div>
              <div>
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Active Faculty</p>
                <p className="text-2xl font-black text-slate-800 dark:text-white">{totalFacultyCount}</p>
              </div>
            </div>
            <div className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex items-center shadow-sm">
              <div className="p-4 bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 rounded-2xl mr-4"><Briefcase size={24} /></div>
              <div>
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Average Total Load</p>
                <p className="text-2xl font-black text-slate-800 dark:text-white">{avgLoad} <span className="text-xs font-bold text-slate-500 dark:text-slate-400">units</span></p>
              </div>
            </div>
            <div className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex items-center shadow-sm">
              <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-2xl mr-4"><TrendingUp size={24} /></div>
              <div>
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Overloaded Faculty</p>
                <p className="text-2xl font-black text-slate-800 dark:text-white">{overloadedCount}</p>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <div className="bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-[#121212]">
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
                <input 
                  type="text" 
                  placeholder="Search faculty or status..." 
                  value={searchQuery} 
                  onChange={(e) => setSearchQuery(e.target.value)} 
                  className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 pl-9 pr-4 text-sm focus:outline-none focus:border-teal-500 text-slate-900 dark:text-white" 
                />
              </div>
              <button className="text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors cursor-pointer"><Filter size={18} /></button>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-50 dark:bg-[#1a1a1c] border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <tr>
                    <th className="px-6 py-4 font-bold text-xs">Faculty Member</th>
                    <th className="px-6 py-4 font-bold text-xs text-center">Regular Units</th>
                    <th className="px-6 py-4 font-bold text-xs text-center">Ancillary Hours</th>
                    <th className="px-6 py-4 font-bold text-xs text-center">Prep Count</th>
                    <th className="px-6 py-4 font-bold text-xs text-center">Total Assigned Load</th>
                    <th className="px-6 py-4 font-bold text-xs text-center">Compliance Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {filteredWorkload.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4 font-bold text-slate-800 dark:text-white">
                        {row.name} 
                        <span className="text-[10px] font-normal text-slate-500 dark:text-slate-400 block">{row.id} • {row.type}</span>
                      </td>
                      <td className="px-6 py-4 text-center font-medium">{row.regLoad} units</td>
                      <td className="px-6 py-4 text-center font-medium text-teal-600 dark:text-teal-400">{row.ancLoad} hrs</td>
                      <td className="px-6 py-4 text-center font-mono text-xs text-slate-500">{row.prepCount} preps</td>
                      <td className="px-6 py-4 text-center font-black">
                        {row.total} / {row.maxLoad} units
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                          row.status === 'Optimal' 
                            ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20' 
                            : row.status === 'Overloaded' 
                            ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20' 
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

      {/* Enterprise Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-4 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="w-8 h-8 rounded-xl bg-teal-500/20 dark:bg-teal-500/15 flex items-center justify-center text-teal-500 shrink-0">
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