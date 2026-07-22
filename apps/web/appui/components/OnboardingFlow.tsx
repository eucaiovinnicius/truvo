'use client';

import React, { useState } from 'react';
import { 
  Check, 
  Code2, 
  Copy, 
  Database, 
  ArrowRight, 
  CheckCircle, 
  Loader2, 
  Sparkles, 
  Building,
  CheckSquare,
  Square,
  ExternalLink,
  HelpCircle,
  Play
} from 'lucide-react';
import { WorkspaceConfig } from '../types';

interface OnboardingFlowProps {
  onComplete: (workspaceName: string) => void;
  onCancel: () => void;
  showCancelButton: boolean;
}

/*
 * TODO(live): este wizard é 100% simulado. Para ligá-lo à API real seriam
 * necessários vários passos (fora do escopo mínimo desta fase):
 *  - Step 1: PATCH /v1/workspaces/:id (nome/segmento) — hoje o nome só volta via onComplete.
 *  - Step 2: POST /v1/api-keys para gerar a chave real do pixel (em vez do pk_live_… fixo)
 *            e escutar o 1º evento (GET /v1/events/volume) em vez do botão de simulação.
 *  - Step 3: "Connect Meta/Google" mapeia para PUT /v1/integrations-out/:platform, que hoje
 *            falha-fechado sem INTEGRATIONS_ENCRYPTION_KEY (mesmo bloqueio da IntegrationsView).
 * Como envolve um fluxo multi-etapas com credenciais e tratamento de erro por passo,
 * priorizamos as telas 1–4 (TrackingView/Funnels/Settings/Reports) e deixamos isto anotado.
 */

export default function OnboardingFlow({ onComplete, onCancel, showCancelButton }: OnboardingFlowProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [workspaceName, setWorkspaceName] = useState('Truvo Global Store');
  const [industry, setIndustry] = useState('E-commerce');
  const [spendTier, setSpendTier] = useState('$5k - $20k');

  // Step 2 Pixel states
  const [pixelStatus, setPixelStatus] = useState<'listening' | 'received'>('listening');
  const [copied, setCopied] = useState(false);

  // Step 3 Ad connectors
  const [metaConnected, setMetaConnected] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [metaConnecting, setMetaConnecting] = useState(false);
  const [googleConnecting, setGoogleConnecting] = useState(false);

  const handleCopyPixel = () => {
    navigator.clipboard.writeText(`tr('init', 'pk_live_68798e98b7a9f2'); tr('track', 'PageView');`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSimulatePixelHit = () => {
    setPixelStatus('received');
  };

  const handleConnectMeta = () => {
    setMetaConnecting(true);
    setTimeout(() => {
      setMetaConnecting(false);
      setMetaConnected(true);
    }, 1200);
  };

  const handleConnectGoogle = () => {
    setGoogleConnecting(true);
    setTimeout(() => {
      setGoogleConnecting(false);
      setGoogleConnected(true);
    }, 1200);
  };

  const handleFinish = () => {
    onComplete(workspaceName);
  };

  return (
    <div id="onboarding-flow-container" className="max-w-xl mx-auto bg-white rounded-3xl border border-slate-100 shadow-2xl p-8 my-8 animate-fadeIn">
      {/* Header and cancel */}
      <div className="flex items-center justify-between pb-6 border-b border-slate-50">
        <div>
          <div className="flex items-center gap-1.5 text-teal-600">
            <Sparkles className="w-4.5 h-4.5" />
            <span className="text-[10px] font-mono font-bold uppercase tracking-widest">Truvo Setup Agent</span>
          </div>
          <h2 className="text-base font-bold text-slate-800 tracking-tight mt-1">Workspace Verification Wizard</h2>
        </div>

        {showCancelButton && (
          <button
            onClick={onCancel}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
          >
            Skip Setup
          </button>
        )}
      </div>

      {/* Progress Dots Bar */}
      <div className="flex items-center gap-2 my-6">
        {([1, 2, 3, 4] as const).map((s) => (
          <div key={s} className="flex-1 flex items-center gap-1.5">
            <div className={`h-1.5 rounded-full transition-all ${
              s === step 
                ? 'w-8 bg-teal-600' 
                : s < step 
                ? 'w-4 bg-emerald-500' 
                : 'w-4 bg-slate-200'
            }`} />
            <span className={`text-[9px] font-mono font-bold ${
              s === step ? 'text-teal-700' : 'text-slate-400'
            }`}>
              S{s}
            </span>
          </div>
        ))}
      </div>

      {/* STEP 1: Brand Info */}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-bold text-slate-800 tracking-tight flex items-center gap-1.5">
              <Building className="w-4 h-4 text-slate-400" />
              <span>Step 1: Tell us about your brand</span>
            </h3>
            <p className="text-xs text-slate-500 leading-normal mt-1">Configure your primary tracking domain and analytics settings.</p>
          </div>

          <div className="space-y-4 pt-2">
            <div>
              <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">E-commerce Brand Label</label>
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:border-teal-500 outline-none"
                placeholder="e.g. My Premium Apparel"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Industry Category</label>
                <select
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 bg-white outline-none"
                >
                  <option value="E-commerce">E-commerce (Shopify/etc)</option>
                  <option value="SaaS">SaaS Platform</option>
                  <option value="B2B Lead Gen">B2B Lead Generation</option>
                  <option value="Infoproducts">Digital Infoproducts</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-1.5">Estimated Ad Spend / mo</label>
                <select
                  value={spendTier}
                  onChange={(e) => setSpendTier(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 bg-white outline-none"
                >
                  <option value="Under $5k">Under $5,000 / month</option>
                  <option value="$5k - $20k">$5,000 - $20,000 / month</option>
                  <option value="$20k - $100k">$20,000 - $100,000 / month</option>
                  <option value="$100k+">$100,000+ / month</option>
                </select>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-50 flex justify-end">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold flex items-center gap-1 cursor-pointer"
            >
              <span>Verify & Continue</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: JS Pixel */}
      {step === 2 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-bold text-slate-800 tracking-tight flex items-center gap-1.5">
              <Code2 className="w-4 h-4 text-slate-400" />
              <span>Step 2: Mount the Truvo JS tracking pixel</span>
            </h3>
            <p className="text-xs text-slate-500 leading-normal mt-1">To identify UTM source drop-offs, paste our code snippet inside your store template headers.</p>
          </div>

          {/* Code snippet block */}
          <div className="bg-slate-900 rounded-2xl p-4 border border-slate-850 relative">
            <pre className="text-[10px] font-mono text-slate-300 leading-normal">
{`<script>
  !function(t,r,u,v,o){t.Truvo=o, ...
  tr('init', 'pk_live_68798e98b7a9f2');
  tr('track', 'PageView');
</script>`}
            </pre>
            <button
              onClick={handleCopyPixel}
              className="absolute top-3 right-3 p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* Connection listening box */}
          <div className="p-4 rounded-2xl border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 transition-all bg-slate-50/50 border-slate-150">
            <div className="flex items-center gap-3">
              {pixelStatus === 'listening' ? (
                <Loader2 className="w-5 h-5 text-teal-600 animate-spin shrink-0" />
              ) : (
                <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
              )}
              <div>
                <h4 className="text-xs font-bold text-slate-800">
                  {pixelStatus === 'listening' ? 'Listening for test connection event...' : 'Pixel received test event!'}
                </h4>
                <p className="text-[10px] text-slate-500 mt-0.5 leading-normal">
                  {pixelStatus === 'listening' 
                    ? 'Submit a dummy page hit or click the simulation button below.' 
                    : 'Success! Your website pixel is actively transmitting web transactions.'}
                </p>
              </div>
            </div>

            {pixelStatus === 'listening' && (
              <button
                onClick={handleSimulatePixelHit}
                className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer shadow-xs shrink-0 self-start sm:self-auto"
              >
                <Play className="w-3 h-3 fill-current" />
                <span>Trigger Simulation</span>
              </button>
            )}
          </div>

          <div className="pt-4 border-t border-slate-50 flex items-center justify-between">
            <button
              onClick={() => setStep(1)}
              className="text-xs text-slate-500 hover:text-slate-800 transition-colors"
            >
              Back
            </button>

            <button
              onClick={() => setStep(3)}
              disabled={pixelStatus === 'listening'}
              className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1 transition-all ${
                pixelStatus === 'received' 
                  ? 'bg-slate-900 hover:bg-slate-800 text-white cursor-pointer' 
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              <span>Connect Channels</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: Ad Channels */}
      {step === 3 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-bold text-slate-800 tracking-tight flex items-center gap-1.5">
              <Database className="w-4 h-4 text-slate-400" />
              <span>Step 3: Connect marketing ad channels</span>
            </h3>
            <p className="text-xs text-slate-500 leading-normal mt-1">Authorize server integration pipelines to overlay ad cost calculations over verified pixel sales.</p>
          </div>

          <div className="space-y-3 pt-2">
            {/* Meta connector */}
            <div className="p-4 border border-slate-100 rounded-2xl bg-slate-50/40 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center font-bold text-indigo-700 text-xs">
                  M
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-800">Meta Ads API Integration</h4>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {metaConnected ? 'Account Connected: Alex Mercer (ID: 9481)' : 'Requires business manager profile access.'}
                  </p>
                </div>
              </div>

              <button
                onClick={handleConnectMeta}
                disabled={metaConnected || metaConnecting}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                  metaConnected 
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' 
                    : metaConnecting 
                    ? 'bg-slate-100 text-slate-400' 
                    : 'bg-white border border-slate-200 hover:border-slate-300 text-slate-700 cursor-pointer shadow-2xs'
                }`}
              >
                {metaConnecting ? 'Connecting...' : metaConnected ? 'Connected' : 'Connect Account'}
              </button>
            </div>

            {/* Google connector */}
            <div className="p-4 border border-slate-100 rounded-2xl bg-slate-50/40 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-red-50 border border-red-100 flex items-center justify-center font-bold text-red-700 text-xs">
                  G
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-800">Google Ads API Integration</h4>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {googleConnected ? 'Account Connected: MCC ID 8903-1124' : 'Sync MCC networks, search and display ads.'}
                  </p>
                </div>
              </div>

              <button
                onClick={handleConnectGoogle}
                disabled={googleConnected || googleConnecting}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                  googleConnected 
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' 
                    : googleConnecting 
                    ? 'bg-slate-100 text-slate-400' 
                    : 'bg-white border border-slate-200 hover:border-slate-300 text-slate-700 cursor-pointer shadow-2xs'
                }`}
              >
                {googleConnecting ? 'Connecting...' : googleConnected ? 'Connected' : 'Connect Account'}
              </button>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-50 flex items-center justify-between">
            <button
              onClick={() => setStep(2)}
              className="text-xs text-slate-500 hover:text-slate-800 transition-colors"
            >
              Back
            </button>

            <button
              onClick={() => setStep(4)}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold flex items-center gap-1 cursor-pointer"
            >
              <span>Complete Setup</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 4: Celebration Success */}
      {step === 4 && (
        <div className="text-center space-y-5 py-4">
          <div className="w-16 h-16 bg-emerald-50 border border-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-md animate-bounce">
            <Check className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <span className="text-[10px] font-mono text-emerald-700 font-bold uppercase tracking-wider">WORKSPACE VERIFIED</span>
            <h3 className="text-lg font-bold text-slate-800 tracking-tight">Truvo Engine is Live!</h3>
            <p className="text-xs text-slate-500 leading-relaxed max-w-sm mx-auto">
              Your server pipelines have established sync tunnels with Meta and Google. Ad spends are now calculated directly over Shopify purchase timestamps.
            </p>
          </div>

          <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100/70 text-left space-y-2 max-w-md mx-auto">
            <div className="flex justify-between text-[11px] font-mono text-slate-500">
              <span>Primary Workspace:</span>
              <span className="font-bold text-slate-800">{workspaceName}</span>
            </div>
            <div className="flex justify-between text-[11px] font-mono text-slate-500">
              <span>Pixel Connection status:</span>
              <span className="font-bold text-emerald-600">Active (Stream)</span>
            </div>
            <div className="flex justify-between text-[11px] font-mono text-slate-500">
              <span>Ad cost pipelines:</span>
              <span className="font-bold text-slate-800">
                {metaConnected && googleConnected ? 'Meta & Google connected' :
                 metaConnected ? 'Meta connected' :
                 googleConnected ? 'Google connected' : 'Local tracking only'}
              </span>
            </div>
          </div>

          <button
            onClick={handleFinish}
            className="w-full py-2.5 bg-linear-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-teal-500/10 cursor-pointer flex items-center justify-center gap-1.5"
          >
            <span>Launch Performance Intelligence</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
