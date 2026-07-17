import React from 'react';
import { 
  ArrowUpRight, 
  ArrowDownRight, 
  DollarSign, 
  TrendingUp, 
  ShoppingBag, 
  Users, 
  Info,
  ChevronRight,
  ExternalLink
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  ComposedChart, 
  Bar, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend 
} from 'recharts';
import { Funnel } from '../types';

interface DashboardViewProps {
  funnels: Funnel[];
  setView: (view: any) => void;
  dateRange: string;
}

export default function DashboardView({ funnels, setView, dateRange }: DashboardViewProps) {
  // Mock performance data for 7-day Composed Chart
  const chartData = [
    { name: 'July 1', Spend: 150, Revenue: 480, Conversions: 11 },
    { name: 'July 2', Spend: 220, Revenue: 710, Conversions: 16 },
    { name: 'July 3', Spend: 190, Revenue: 640, Conversions: 14 },
    { name: 'July 4', Spend: 280, Revenue: 950, Conversions: 21 },
    { name: 'July 5', Spend: 310, Revenue: 1120, Conversions: 26 },
    { name: 'July 6', Spend: 240, Revenue: 830, Conversions: 19 },
    { name: 'July 7', Spend: 350, Revenue: 1312, Conversions: 29 },
  ];

  const trafficSources = [
    { source: 'meta / cpc', revenue: 2185.20, conversions: 54, roas: '3.08x', quality: '9.2', status: 'Syncing', statusColor: 'text-teal-600 bg-teal-50' },
    { source: 'google / search', revenue: 1240.50, conversions: 28, roas: '3.52x', quality: '8.8', status: 'Syncing', statusColor: 'text-teal-600 bg-teal-50' },
    { source: 'tiktok / spark', revenue: 310.00, conversions: 7, roas: '0.91x', quality: '6.5', status: 'Error', statusColor: 'text-rose-600 bg-rose-50' },
    { source: 'newsletter / email', revenue: 280.00, conversions: 14, roas: '7.20x', quality: '9.5', status: 'Active', statusColor: 'text-emerald-600 bg-emerald-50' },
    { source: 'direct / none', revenue: 87.80, conversions: 2, roas: '--', quality: '--', status: 'Active', statusColor: 'text-slate-600 bg-slate-50' },
  ];

  return (
    <div id="dashboard-view-container" className="space-y-6">
      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Card 1: Attributed Revenue */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">Attributed Revenue</span>
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              <ArrowUpRight className="w-3 h-3" />
              18.4%
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight">$4,103.50</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Model-attributable sales
            </p>
          </div>
          <div className="mt-4 h-10 w-full">
            {/* Elegant Vector Micro Sparkline */}
            <svg className="w-full h-full text-teal-500 overflow-visible" viewBox="0 0 120 40" preserveAspectRatio="none">
              <defs>
                <linearGradient id="grad-revenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path d="M 0 32 C 20 28, 40 12, 60 18 C 80 24, 100 8, 120 10 L 120 40 L 0 40 Z" fill="url(#grad-revenue)" />
              <path d="M 0 32 C 20 28, 40 12, 60 18 C 80 24, 100 8, 120 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* Card 2: Blended ROAS */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">Blended ROAS</span>
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              <ArrowUpRight className="w-3 h-3" />
              4.2%
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight">3.38x</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Revenue / Ad Spend ratio
            </p>
          </div>
          <div className="mt-4 h-10 w-full">
            <svg className="w-full h-full text-emerald-500 overflow-visible" viewBox="0 0 120 40" preserveAspectRatio="none">
              <defs>
                <linearGradient id="grad-roas" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path d="M 0 34 C 20 30, 40 32, 60 22 C 80 12, 100 14, 120 8 L 120 40 L 0 40 Z" fill="url(#grad-roas)" />
              <path d="M 0 34 C 20 30, 40 32, 60 22 C 80 12, 100 14, 120 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* Card 3: Blended CAC */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">Blended CAC</span>
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              <ArrowDownRight className="w-3 h-3" />
              8.6%
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight">$13.25</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Ad spend per acquisition
            </p>
          </div>
          <div className="mt-4 h-10 w-full">
            <svg className="w-full h-full text-teal-600 overflow-visible" viewBox="0 0 120 40" preserveAspectRatio="none">
              <defs>
                <linearGradient id="grad-cac" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path d="M 0 12 C 20 14, 40 18, 60 16 C 80 14, 100 28, 120 30 L 120 40 L 0 40 Z" fill="url(#grad-cac)" />
              <path d="M 0 12 C 20 14, 40 18, 60 16 C 80 14, 100 28, 120 30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* Card 4: New Customer Share */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">New Customer Share</span>
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              <ArrowUpRight className="w-3 h-3" />
              1.8%
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-sans">84.6%</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              First-purchase transaction share
            </p>
          </div>
          <div className="mt-4 h-10 w-full">
            <svg className="w-full h-full text-indigo-500 overflow-visible" viewBox="0 0 120 40" preserveAspectRatio="none">
              <defs>
                <linearGradient id="grad-share" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path d="M 0 30 C 20 28, 40 24, 60 25 C 80 26, 100 14, 120 12 L 120 40 L 0 40 Z" fill="url(#grad-share)" />
              <path d="M 0 30 C 20 28, 40 24, 60 25 C 80 26, 100 14, 120 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </div>

      {/* Main Double-Axis Performance Chart */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Multi-Channel Attribution Feed</h3>
            <p className="text-xs text-slate-500 mt-1 font-sans">Blended marketing spend vs model-verified conversions over time ({dateRange})</p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-teal-500 rounded-xs" />
              <span className="text-slate-600 font-medium">Verified Sales ($)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-1.5 bg-slate-800 rounded-full inline-block" />
              <span className="text-slate-600 font-medium">Ad Spend ($)</span>
            </div>
          </div>
        </div>

        <div className="h-80 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: -5, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#14b8a6" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis 
                dataKey="name" 
                stroke="#94a3b8" 
                fontSize={10} 
                fontFamily="JetBrains Mono" 
                tickLine={false} 
                axisLine={false} 
              />
              <YAxis 
                yAxisId="left" 
                stroke="#94a3b8" 
                fontSize={10} 
                fontFamily="JetBrains Mono" 
                tickLine={false} 
                axisLine={false} 
                tickFormatter={(val) => `$${val}`}
              />
              <YAxis 
                yAxisId="right" 
                orientation="right" 
                stroke="#94a3b8" 
                fontSize={10} 
                fontFamily="JetBrains Mono" 
                tickLine={false} 
                axisLine={false} 
                tickFormatter={(val) => `${val} conv`}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: '#ffffff', 
                  border: '1px solid #e2e8f0', 
                  borderRadius: '12px',
                  fontFamily: 'Inter',
                  fontSize: '11px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                }}
              />
              <Bar yAxisId="left" dataKey="Revenue" fill="#14b8a6" fillOpacity={0.85} radius={[6, 6, 0, 0]} barSize={35} name="Attributed Sales" />
              <Line yAxisId="left" type="monotone" dataKey="Spend" stroke="#0f172a" strokeWidth={2.5} dot={{ r: 3, fill: '#0f172a', strokeWidth: 0 }} activeDot={{ r: 5 }} name="Ad Spend" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Grid: Channels Table & Funnels Conversion Pulse */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Traffic Channels - Col Span 7 */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-7">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">UTM Source Intelligence</h3>
              <p className="text-xs text-slate-500 mt-1">Cross-channel attribution score & direct model-verified revenue</p>
            </div>
            <button 
              onClick={() => setView('attribution')}
              className="text-teal-600 hover:text-teal-700 text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
            >
              <span>Explore Attribution</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                  <th className="py-3 font-semibold">Traffic Source</th>
                  <th className="py-3 font-semibold text-right">Attributed Revenue</th>
                  <th className="py-3 font-semibold text-right">Conversions</th>
                  <th className="py-3 font-semibold text-right">ROAS</th>
                  <th className="py-3 font-semibold text-right">Quality Score</th>
                  <th className="py-3 font-semibold text-center">Pipeline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {trafficSources.map((t, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/50 transition-colors text-xs font-sans text-slate-700">
                    <td className="py-3.5">
                      <span className="font-mono text-xs font-medium text-slate-900 bg-slate-50 border border-slate-100 px-2 py-1 rounded-md">
                        {t.source}
                      </span>
                    </td>
                    <td className="py-3.5 text-right font-semibold text-slate-900">${t.revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td className="py-3.5 text-right font-mono font-medium">{t.conversions}</td>
                    <td className="py-3.5 text-right font-semibold text-emerald-600">{t.roas}</td>
                    <td className="py-3.5 text-right">
                      {t.quality !== '--' ? (
                        <span className="font-mono font-bold text-teal-700">{t.quality} <span className="text-[9px] text-slate-400">/10</span></span>
                      ) : '--'}
                    </td>
                    <td className="py-3.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-mono font-semibold ${t.statusColor}`}>
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Funnels Pulse - Col Span 5 */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Funnels Health</h3>
                <p className="text-xs text-slate-500 mt-1 font-sans">Real-time conversion completion rate & step fall-off</p>
              </div>
              <button 
                onClick={() => setView('funnels')}
                className="text-teal-600 hover:text-teal-700 text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
              >
                <span>All Funnels</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {funnels.slice(0, 3).map((f) => {
                const stepCount = f.steps.length;
                const endReach = stepCount > 0 ? f.steps[stepCount - 1].reach : 0;
                const startReach = stepCount > 0 ? f.steps[0].reach : 0;
                const rate = startReach > 0 ? ((endReach / startReach) * 100).toFixed(1) : '0.0';

                return (
                  <div key={f.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100/70 hover:border-slate-200 transition-all">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-800 truncate pr-2">{f.name}</span>
                      <span className={`px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-semibold uppercase ${
                        f.status === 'active' 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : f.status === 'inactive' 
                          ? 'bg-slate-200 text-slate-600' 
                          : 'bg-amber-100 text-amber-800'
                      }`}>
                        {f.status}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono mb-1.5">
                      <span>Conversion Rate</span>
                      <span className="font-bold text-teal-700">{rate}%</span>
                    </div>

                    {/* Progress Bar represent first vs last step reach */}
                    <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full bg-linear-to-r ${
                          f.status === 'active' 
                            ? 'from-teal-500 to-emerald-600' 
                            : f.status === 'inactive' 
                            ? 'from-slate-400 to-slate-500' 
                            : 'from-amber-400 to-amber-500'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(5, parseFloat(rate)))}%` }}
                      />
                    </div>

                    {/* Step counters */}
                    <div className="flex items-center justify-between text-[9px] text-slate-400 font-mono mt-2 pt-1 border-t border-slate-100">
                      <span>{stepCount} Active Steps</span>
                      <span>{endReach.toLocaleString()} purchases</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100">
            <button
              onClick={() => setView('funnel-builder')}
              className="w-full py-2 bg-linear-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-teal-600/10 cursor-pointer flex items-center justify-center gap-1.5"
            >
              <span>Build Custom Journey Funnel</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
