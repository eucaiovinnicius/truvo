import React, { useState } from 'react';
import { 
  Bell, 
  Calendar, 
  Search, 
  CheckCircle, 
  AlertCircle, 
  RefreshCw, 
  ChevronDown,
  Info
} from 'lucide-react';
import { ViewState } from '../types';

interface TopBarProps {
  currentView: ViewState;
  dateRange: string;
  setDateRange: (range: string) => void;
  onRefreshAll: () => void;
  isRefreshing: boolean;
}

export default function TopBar({ 
  currentView, 
  dateRange, 
  setDateRange,
  onRefreshAll,
  isRefreshing 
}: TopBarProps) {
  const [showNotificationDropdown, setShowNotificationDropdown] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const viewTitles: Record<ViewState, string> = {
    onboarding: 'Setup & Onboarding Wizard',
    dashboard: 'Intelligence Dashboard',
    funnels: 'Conversion Funnel Health',
    'funnel-builder': 'Multi-Stage Funnel Architect',
    attribution: 'Advanced Attribution Center',
    tracking: 'SDK & API Integrations',
    settings: 'Workspace Settings'
  };

  const notifications = [
    {
      id: 'n-1',
      type: 'error',
      title: 'TikTok Ads Authentication Expired',
      message: 'Re-authenticate TikTok Business account to restore syncing.',
      time: '2h ago'
    },
    {
      id: 'n-2',
      type: 'warning',
      title: 'Attribution Gap Detected',
      message: 'Meta reported sales are 43% lower than model calculated values.',
      time: '4h ago'
    },
    {
      id: 'n-3',
      type: 'success',
      title: 'Shopify Pixel Active',
      message: 'Server-side purchase webhook streaming live transactions.',
      time: 'Just now'
    }
  ];

  const dateRanges = ['Today', 'Yesterday', 'Last 7 Days', 'Last 30 Days', 'This Month', 'Custom Range'];

  return (
    <header id="topbar-container" className="h-16 border-b border-slate-100 bg-white/80 backdrop-blur-md flex items-center justify-between px-8 sticky top-0 z-10 w-[calc(100%-16rem)] ml-64">
      {/* Title & Status */}
      <div className="flex items-center gap-4">
        <div>
          <h1 id="topbar-view-title" className="text-sm font-bold text-slate-800 tracking-tight">
            {viewTitles[currentView]}
          </h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full sync-pulse" />
            <span className="text-[10px] font-medium text-slate-500 font-mono uppercase tracking-wider">
              All Pipelines Synced (Live UTC)
            </span>
          </div>
        </div>
      </div>

      {/* Action Area */}
      <div className="flex items-center gap-3">
        {/* Refresh button */}
        <button
          onClick={onRefreshAll}
          className={`p-2 rounded-lg border border-slate-100 bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-800 transition-all ${
            isRefreshing ? 'animate-spin text-teal-600 border-teal-200 bg-teal-50/20' : ''
          }`}
          title="Refresh Data Pipelines"
        >
          <RefreshCw className="w-4 h-4" />
        </button>

        {/* Date Selector */}
        <div className="relative">
          <button
            id="date-picker-btn"
            onClick={() => setShowDatePicker(!showDatePicker)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-100 hover:border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:text-slate-900 transition-all cursor-pointer"
          >
            <Calendar className="w-4 h-4 text-slate-400" />
            <span>{dateRange}</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </button>

          {showDatePicker && (
            <div className="absolute top-full right-0 mt-1 bg-white border border-slate-100 rounded-lg shadow-lg z-50 py-1 w-44">
              {dateRanges.map((range) => (
                <button
                  key={range}
                  onClick={() => {
                    setDateRange(range);
                    setShowDatePicker(false);
                  }}
                  className={`w-full px-3 py-2 text-xs text-left font-medium hover:bg-slate-50 block ${
                    range === dateRange ? 'text-teal-600 bg-teal-50/20 font-semibold' : 'text-slate-600'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Info/Support pill */}
        <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-slate-600">
          <Info className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-mono">IP: Server-Direct</span>
        </div>

        {/* Notifications center */}
        <div className="relative">
          <button
            id="notification-bell-btn"
            onClick={() => setShowNotificationDropdown(!showNotificationDropdown)}
            className="relative p-2 rounded-lg border border-slate-100 bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-800 transition-all"
          >
            <Bell className="w-4 h-4" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-rose-500 rounded-full border border-white" />
          </button>

          {showNotificationDropdown && (
            <div className="absolute top-full right-0 mt-1.5 w-80 bg-white border border-slate-100 rounded-lg shadow-xl z-50 overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">System Notifications</span>
                <span className="text-[10px] font-mono text-rose-500 font-semibold uppercase">3 Alerts</span>
              </div>
              <div className="divide-y divide-slate-50 max-h-80 overflow-y-auto">
                {notifications.map((notif) => (
                  <div key={notif.id} className="p-3 hover:bg-slate-50/50 transition-colors">
                    <div className="flex gap-2 items-start">
                      {notif.type === 'error' && <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />}
                      {notif.type === 'warning' && <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />}
                      {notif.type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />}
                      <div className="flex-1">
                        <h4 className="text-[11px] font-bold text-slate-800 leading-normal">{notif.title}</h4>
                        <p className="text-[10px] text-slate-500 leading-normal mt-0.5">{notif.message}</p>
                        <span className="text-[9px] text-slate-400 block mt-1 font-mono">{notif.time}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
