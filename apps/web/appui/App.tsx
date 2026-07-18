'use client';

import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import DashboardView from './components/DashboardView';
import FunnelsView from './components/FunnelsView';
import FunnelBuilderView from './components/FunnelBuilderView';
import AttributionView from './components/AttributionView';
import TrackingView from './components/TrackingView';
import SettingsView from './components/SettingsView';
import OnboardingFlow from './components/OnboardingFlow';
import LoginView from './components/LoginView';
import { ViewState, Funnel, CampaignRow, Integration, ApiKey, WorkspaceConfig, ProfileConfig } from './types';
import { initialFunnels, initialCampaigns, initialIntegrations, initialApiKeys } from './data';
import { useSession } from '@/lib/session';
import { HelpCircle, RefreshCw, Sparkles, Check } from 'lucide-react';

export default function App() {
  const session = useSession();

  const [currentView, setView] = useState<ViewState>('dashboard');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [dateRange, setDateRange] = useState('Last 7 Days');

  // Core business configurations
  const [workspace, setWorkspace] = useState<WorkspaceConfig>({
    name: 'Truvo Global Store',
    slug: 'truvo-global',
    timezone: 'America/New_York',
    currency: 'USD'
  });

  const [profile, setProfile] = useState<ProfileConfig>(() => {
    const saved = localStorage.getItem('truvo_profile');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // ignore
      }
    }
    return {
      fullName: 'Alex Mercer',
      email: 'alex@truvo.ai',
      avatarUrl: ''
    };
  });

  const handleLoginSuccess = (newProfile: ProfileConfig) => {
    setProfile(newProfile);
    localStorage.setItem('truvo_profile', JSON.stringify(newProfile));
    setView('onboarding');
  };

  const handleLogout = () => {
    session.logout();
    localStorage.removeItem('truvo_profile');
    setView('dashboard');
  };

  // Business metrics lists
  const [funnels, setFunnels] = useState<Funnel[]>(initialFunnels);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>(initialCampaigns);
  const [integrations, setIntegrations] = useState<Integration[]>(initialIntegrations);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(initialApiKeys);
  const [selectedFunnelId, setSelectedFunnelId] = useState<string | null>('ecommerce-main');

  // Launch onboarding wizard trigger
  const handleStartOnboarding = () => {
    setView('onboarding');
  };

  // Onboarding completion handler
  const handleCompleteOnboarding = (newWorkspaceName: string) => {
    setWorkspace(prev => ({ ...prev, name: newWorkspaceName }));
    setView('dashboard');
  };

  // Pipeline refresh simulation
  const handleRefreshAll = () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setIsRefreshing(false);
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 3000);
    }, 1500);
  };

  // Router to direct selected funnel to builder
  const handleEditFunnel = (funnelId: string) => {
    setSelectedFunnelId(funnelId);
    setView('funnel-builder');
  };

  // Create new blank funnel template
  const handleAddNewFunnel = () => {
    const nextId = `funnel-new-${Date.now()}`;
    const newFunnel: Funnel = {
      id: nextId,
      name: 'Custom Marketing Journey',
      status: 'draft',
      conversionRate: 0.0,
      totalSteps: 2,
      updatedTime: 'Created just now',
      sparklineData: [0, 0, 0, 0, 0, 0, 0],
      steps: [
        { id: `s1-${nextId}`, stepNumber: 1, name: 'Ad Landing', eventType: 'page_view', conditions: [], reach: 1000 },
        { id: `s2-${nextId}`, stepNumber: 2, name: 'Product Click', eventType: 'view_item', conditions: [], reach: 250 }
      ]
    };

    setFunnels(prev => [...prev, newFunnel]);
    setSelectedFunnelId(nextId);
    setView('funnel-builder');
  };

  // Builder commit callback
  const handleSaveFunnel = (updatedFunnel: Funnel) => {
    setFunnels(prev => prev.map(f => f.id === updatedFunnel.id ? updatedFunnel : f));
  };

  if (!session.ready) {
    return null;
  }
  if (!session.mode) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-slate-50/50 flex font-sans antialiased text-slate-900 selection:bg-teal-500/15 selection:text-teal-900">
      {/* Sidebar Navigation */}
      <Sidebar 
        currentView={currentView} 
        setView={setView} 
        workspaceName={workspace.name} 
        setWorkspaceName={(name) => setWorkspace(prev => ({ ...prev, name }))}
        onStartOnboarding={handleStartOnboarding}
        profile={profile}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header Controls */}
        <TopBar 
          currentView={currentView}
          dateRange={dateRange}
          setDateRange={setDateRange}
          onRefreshAll={handleRefreshAll}
          isRefreshing={isRefreshing}
        />

        {/* Global Pipeline Refresh Indicator Toast */}
        {refreshSuccess && (
          <div className="fixed top-20 right-8 z-50 bg-slate-900 border border-slate-800 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 animate-fadeIn font-sans">
            <Check className="w-4 h-4 text-teal-400 shrink-0" />
            <span>Ad spends and Shopify purchase logs re-synced successfully.</span>
          </div>
        )}

        {/* Main Body content with padding offsets */}
        <main className="flex-1 p-8 ml-64 overflow-y-auto">
          <div className="max-w-[1300px] mx-auto">
            
            {/* Conditional Sub-View Router */}
            {currentView === 'onboarding' && (
              <OnboardingFlow 
                onComplete={handleCompleteOnboarding} 
                onCancel={() => setView('dashboard')}
                showCancelButton={true}
              />
            )}

            {currentView === 'dashboard' && (
              <DashboardView 
                funnels={funnels} 
                setView={setView}
                dateRange={dateRange}
              />
            )}

            {currentView === 'funnels' && (
              <FunnelsView 
                funnels={funnels}
                setFunnels={setFunnels}
                onEditFunnel={handleEditFunnel}
                onAddNewFunnel={handleAddNewFunnel}
              />
            )}

            {currentView === 'funnel-builder' && (
              <FunnelBuilderView 
                funnels={funnels}
                selectedFunnelId={selectedFunnelId}
                onSaveFunnel={handleSaveFunnel}
                setView={setView}
              />
            )}

            {currentView === 'attribution' && (
              <AttributionView 
                campaigns={campaigns}
                setCampaigns={setCampaigns}
                dateRange={dateRange}
              />
            )}

            {currentView === 'tracking' && (
              <TrackingView 
                integrations={integrations}
                setIntegrations={setIntegrations}
                apiKeys={apiKeys}
                setApiKeys={setApiKeys}
              />
            )}

            {currentView === 'settings' && (
              <SettingsView 
                profile={profile}
                setProfile={setProfile}
                workspace={workspace}
                setWorkspace={setWorkspace}
              />
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
