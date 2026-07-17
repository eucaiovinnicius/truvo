import React, { useState } from 'react';
import { 
  User, 
  Settings, 
  Users, 
  CreditCard, 
  Plus, 
  CheckCircle, 
  Trash2, 
  Sparkles,
  Info,
  Lock,
  Globe
} from 'lucide-react';
import { WorkspaceConfig, ProfileConfig } from '../types';

interface SettingsViewProps {
  profile: ProfileConfig;
  setProfile: React.Dispatch<React.SetStateAction<ProfileConfig>>;
  workspace: WorkspaceConfig;
  setWorkspace: React.Dispatch<React.SetStateAction<WorkspaceConfig>>;
}

export default function SettingsView({ 
  profile, 
  setProfile, 
  workspace, 
  setWorkspace 
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<'profile' | 'workspace' | 'team' | 'billing'>('profile');
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Teams list state
  const [teamMembers, setTeamMembers] = useState([
    { id: 1, name: 'Alex Mercer', email: 'alex@truvo.ai', role: 'Owner', status: 'Active' },
    { id: 2, name: 'Samantha Cole', email: 'sam@truvo.ai', role: 'Growth Marketer', status: 'Active' },
    { id: 3, name: 'John Sterling', email: 'john@truvo.ai', role: 'Lead Developer', status: 'Pending Invite' }
  ]);

  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('Growth Marketer');

  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleWorkspaceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleInviteMember = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteName || !inviteEmail) return;

    setTeamMembers([
      ...teamMembers,
      {
        id: Date.now(),
        name: inviteName,
        email: inviteEmail,
        role: inviteRole,
        status: 'Pending Invite'
      }
    ]);
    setInviteName('');
    setInviteEmail('');
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleDeleteMember = (id: number) => {
    if (window.confirm('Are you sure you want to revoke workspace access for this member?')) {
      setTeamMembers(prev => prev.filter(m => m.id !== id));
    }
  };

  return (
    <div id="settings-view-container" className="bg-white rounded-2xl border border-slate-100 shadow-xs overflow-hidden">
      {/* Settings layout with side navigation tab list */}
      <div className="flex flex-col md:flex-row min-h-[500px]">
        {/* Left Side Tab Navigation */}
        <div className="w-full md:w-56 bg-slate-50/50 border-r border-slate-100 p-4 space-y-1 shrink-0">
          <button
            onClick={() => setActiveTab('profile')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all text-left cursor-pointer ${
              activeTab === 'profile' 
                ? 'bg-teal-50 text-teal-800 border-l-2 border-teal-600 font-bold' 
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <User className="w-4 h-4 shrink-0" />
            <span>My Profile</span>
          </button>

          <button
            onClick={() => setActiveTab('workspace')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all text-left cursor-pointer ${
              activeTab === 'workspace' 
                ? 'bg-teal-50 text-teal-800 border-l-2 border-teal-600 font-bold' 
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span>Workspace Config</span>
          </button>

          <button
            onClick={() => setActiveTab('team')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all text-left cursor-pointer ${
              activeTab === 'team' 
                ? 'bg-teal-50 text-teal-800 border-l-2 border-teal-600 font-bold' 
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <Users className="w-4 h-4 shrink-0" />
            <span>Team Members</span>
          </button>

          <button
            onClick={() => setActiveTab('billing')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all text-left cursor-pointer ${
              activeTab === 'billing' 
                ? 'bg-teal-50 text-teal-800 border-l-2 border-teal-600 font-bold' 
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <CreditCard className="w-4 h-4 shrink-0" />
            <span>Billing & Usage</span>
          </button>
        </div>

        {/* Right Side Pane Content */}
        <div className="flex-1 p-8 space-y-6">
          {/* Success toast */}
          {saveSuccess && (
            <div className="bg-emerald-50 border border-emerald-100 p-3 rounded-xl flex items-center gap-2 text-emerald-800 text-xs">
              <CheckCircle className="w-4 h-4 text-emerald-600" />
              <span>Settings updated successfully!</span>
            </div>
          )}

          {/* TAB 1: Profile Form */}
          {activeTab === 'profile' && (
            <form onSubmit={handleProfileSubmit} className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-slate-800 tracking-tight">Personal Profile Settings</h3>
                <p className="text-xs text-slate-400 mt-0.5">Control how your notifications and reports are signed.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Full Legal Name</label>
                  <input
                    type="text"
                    required
                    value={profile.fullName}
                    onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:border-teal-500 outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Registered Email</label>
                  <input
                    type="email"
                    required
                    value={profile.email}
                    onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold text-slate-850 focus:border-teal-500 outline-none"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-slate-50">
                <button
                  type="submit"
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold cursor-pointer"
                >
                  Save Profile Changes
                </button>
              </div>
            </form>
          )}

          {/* TAB 2: Workspace Config */}
          {activeTab === 'workspace' && (
            <form onSubmit={handleWorkspaceSubmit} className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-slate-800 tracking-tight">Workspace & Localization Config</h3>
                <p className="text-xs text-slate-400 mt-0.5">Customize default currencies and URL slug layouts.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Workspace Brand Label</label>
                  <input
                    type="text"
                    required
                    value={workspace.name}
                    onChange={(e) => setWorkspace({ ...workspace, name: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold text-slate-850 focus:border-teal-500 outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Workspace URL Slug</label>
                  <div className="flex">
                    <span className="px-2.5 py-1.5 bg-slate-100 border border-slate-200 border-r-0 rounded-l-lg text-[10px] font-mono text-slate-500 flex items-center">
                      truvo.ai/
                    </span>
                    <input
                      type="text"
                      required
                      value={workspace.slug}
                      onChange={(e) => setWorkspace({ ...workspace, slug: e.target.value })}
                      className="flex-1 px-3 py-1.5 border border-slate-200 rounded-r-lg text-xs font-semibold text-slate-850 focus:border-teal-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Reporting Timezone</label>
                  <select
                    value={workspace.timezone}
                    onChange={(e) => setWorkspace({ ...workspace, timezone: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold text-slate-850 bg-white outline-none focus:border-teal-500"
                  >
                    <option value="America/New_York">America/New_York (EST)</option>
                    <option value="Europe/London">Europe/London (GMT)</option>
                    <option value="America/Sao_Paulo">America/Sao_Paulo (BRT)</option>
                    <option value="Asia/Tokyo">Asia/Tokyo (JST)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Base Currency</label>
                  <select
                    value={workspace.currency}
                    onChange={(e) => setWorkspace({ ...workspace, currency: e.target.value as any })}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold text-slate-850 bg-white outline-none focus:border-teal-500"
                  >
                    <option value="USD">USD ($ - United States Dollar)</option>
                    <option value="EUR">EUR (€ - Euro)</option>
                    <option value="BRL">BRL (R$ - Brazilian Real)</option>
                  </select>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-50">
                <button
                  type="submit"
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold cursor-pointer"
                >
                  Save Workspace Localization
                </button>
              </div>
            </form>
          )}

          {/* TAB 3: Team Members */}
          {activeTab === 'team' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-slate-100">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 tracking-tight">Manage Team Access</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Control roles and invite collaborative marketers.</p>
                </div>
              </div>

              {/* Team List Table */}
              <div className="overflow-x-auto border border-slate-100 rounded-xl">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-[10px] font-mono text-slate-400 uppercase tracking-wider border-b border-slate-100">
                      <th className="py-2.5 px-3 font-semibold">User Member</th>
                      <th className="py-2.5 px-3 font-semibold">Role</th>
                      <th className="py-2.5 px-3 font-semibold">Status</th>
                      <th className="py-2.5 px-3 text-center font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {teamMembers.map((member) => (
                      <tr key={member.id} className="hover:bg-slate-50/50 transition-colors">
                        <td className="py-3 px-3">
                          <span className="font-bold text-slate-800 block">{member.name}</span>
                          <span className="text-[10px] text-slate-400 block mt-0.5">{member.email}</span>
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-700">{member.role}</td>
                        <td className="py-3 px-3">
                          <span className={`inline-block px-1.5 py-0.2 rounded-full text-[9px] font-mono font-bold uppercase ${
                            member.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
                          }`}>
                            {member.status}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center">
                          {member.role !== 'Owner' ? (
                            <button
                              onClick={() => handleDeleteMember(member.id)}
                              className="p-1 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-md transition-colors cursor-pointer"
                              title="Revoke Member Access"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-400 italic">Primary</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Invite Form inline */}
              <form onSubmit={handleInviteMember} className="p-4 bg-slate-50/50 border border-slate-150 rounded-xl space-y-3">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-bold block">Invite New Member</span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    required
                    placeholder="Name (e.g. Liam Porter)"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 outline-none"
                  />
                  <input
                    type="email"
                    required
                    placeholder="Email Address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 outline-none"
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 outline-none"
                  >
                    <option value="Growth Marketer">Growth Marketer</option>
                    <option value="Lead Developer">Lead Developer</option>
                    <option value="Auditor">Auditor (View Only)</option>
                  </select>
                </div>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                >
                  Send Invitation
                </button>
              </form>
            </div>
          )}

          {/* TAB 4: Billing & Meter */}
          {activeTab === 'billing' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-slate-800 tracking-tight">Active Plan & Transactions Quota</h3>
                <p className="text-xs text-slate-400 mt-0.5">Track your volume usage against pipeline allocations.</p>
              </div>

              <div className="p-5 border border-slate-150 rounded-2xl bg-slate-50/50 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono text-teal-800 font-bold uppercase bg-teal-50 px-2 py-0.5 rounded-sm">Enterprise Growth Tier</span>
                    <h4 className="text-base font-bold text-slate-800 mt-1.5">$149 / monthly</h4>
                  </div>
                  <span className="text-xs text-slate-500 font-sans">Renews on August 2, 2026</span>
                </div>

                {/* Meter progress bar */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                    <span>Tracked transactions this cycle</span>
                    <span className="font-bold text-slate-800">84,600 / 100,000 (84.6%)</span>
                  </div>

                  <div className="w-full bg-slate-200 h-3 rounded-full overflow-hidden">
                    <div className="h-full bg-linear-to-r from-teal-500 to-emerald-600 rounded-full" style={{ width: '84.6%' }} />
                  </div>
                </div>

                <div className="pt-2 text-[10px] text-slate-400 leading-normal flex items-start gap-1.5 font-sans">
                  <Info className="w-4 h-4 text-slate-350 shrink-0 mt-0.5" />
                  <p>
                    Overage protection is active: We will buffer up to 10% overages without billing interruptions before pausing tracking feeds.
                  </p>
                </div>
              </div>

              <div className="p-4 border border-slate-100 rounded-xl bg-white flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-700">
                    <Lock className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-800 block">Payment Instrument</span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">Corporate Visa ending in 5894</span>
                  </div>
                </div>

                <button
                  onClick={() => alert('Secure Stripe Customer Billing Portal would open in production.')}
                  className="px-3 py-1.5 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-[10px] font-bold rounded-lg transition-colors cursor-pointer"
                >
                  Manage Payment Method
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
