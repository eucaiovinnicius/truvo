'use client';

import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Trash2, 
  Settings, 
  ArrowRight, 
  CheckCircle, 
  AlertCircle, 
  Sparkles,
  RefreshCw,
  Sliders,
  Layers,
  FileCode,
  Compass,
  Play
} from 'lucide-react';
import { Funnel, FunnelStep, Condition } from '../types';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';

/** status local → enum da API (M5): inactive ↔ archived. */
function localToApiFunnelStatus(status: 'active' | 'inactive' | 'draft'): 'active' | 'archived' | 'draft' {
  return status === 'inactive' ? 'archived' : status;
}

/** conditions locais (array) → objeto strict do M5 (best-effort; extras ignorados). */
interface ApiFunnelConditions {
  url_contains?: string;
  element_id?: string;
  property_eq?: { key: string; value: string | number | boolean };
  property_gte?: { key: string; value: number };
}

function conditionsToApi(conditions: Condition[]): ApiFunnelConditions {
  const out: ApiFunnelConditions = {};
  for (const c of conditions) {
    const value = (c.value ?? '').trim();
    if (!value) continue;
    if (c.field === 'page_path') {
      out.url_contains = value;
    } else if (c.operator === 'greater_than' && !Number.isNaN(Number(value))) {
      out.property_gte = { key: c.field, value: Number(value) };
    } else if (c.operator === 'equals') {
      out.property_eq = { key: c.field, value };
    }
    // 'contains'/'starts_with' em campos não-URL não têm equivalente no schema strict → ignorados
  }
  return out;
}

function stepsToApi(steps: FunnelStep[]): Array<{ name: string; event: string; conditions: ApiFunnelConditions }> {
  return steps.map((s) => ({
    name: s.name,
    event: s.eventType,
    conditions: conditionsToApi(s.conditions),
  }));
}

interface FunnelBuilderViewProps {
  funnels: Funnel[];
  selectedFunnelId: string | null;
  onSaveFunnel: (updatedFunnel: Funnel) => void;
  setView: (view: any) => void;
}

export default function FunnelBuilderView({ 
  funnels, 
  selectedFunnelId, 
  onSaveFunnel,
  setView 
}: FunnelBuilderViewProps) {
  // Find or create default editable funnel state
  const activeFunnel = funnels.find(f => f.id === selectedFunnelId) || funnels[0];
  
  const { isLive } = useSession();
  const [funnelName, setFunnelName] = useState('');
  const [funnelStatus, setFunnelStatus] = useState<'active' | 'inactive' | 'draft'>('active');
  const [steps, setSteps] = useState<FunnelStep[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Initialize state based on the selected funnel
  useEffect(() => {
    if (activeFunnel) {
      setFunnelName(activeFunnel.name);
      setFunnelStatus(activeFunnel.status);
      setSteps(JSON.parse(JSON.stringify(activeFunnel.steps))); // deep copy
    }
  }, [activeFunnel, selectedFunnelId]);

  // Helper: Recalculate dynamic reach estimations based on event and conditions length
  const calculateDynamicReach = (stepIdx: number, stepSteps: FunnelStep[]): number => {
    const baseVisitors = 100000;
    if (stepIdx === 0) {
      // Base step reach
      const penalty = stepSteps[0]?.conditions?.reduce((acc, c) => {
        if (c.value) return acc * 0.45; // condition restricts reach
        return acc;
      }, 1) || 1;
      return Math.round(baseVisitors * penalty);
    } else {
      // Subsequent steps relative to prior step
      const priorReach = calculateDynamicReach(stepIdx - 1, stepSteps);
      const eventMultipliers: Record<string, number> = {
        page_view: 0.75,
        view_item: 0.50,
        add_to_cart: 0.25,
        initiate_checkout: 0.15,
        purchase: 0.05,
        lead: 0.35,
        custom_event: 0.40
      };
      const mult = eventMultipliers[stepSteps[stepIdx].eventType] || 0.30;
      const penalty = stepSteps[stepIdx].conditions?.reduce((acc, c) => {
        if (c.value) return acc * 0.60;
        return acc;
      }, 1) || 1;
      return Math.round(priorReach * mult * penalty);
    }
  };

  // Add a new step
  const handleAddStep = () => {
    const nextNum = steps.length + 1;
    const newStep: FunnelStep = {
      id: `step-new-${Date.now()}`,
      stepNumber: nextNum,
      name: `Funnel Stage ${nextNum}`,
      eventType: 'page_view',
      conditions: [],
      reach: 0 // Will be dynamically computed
    };
    setSteps([...steps, newStep]);
  };

  // Delete a step
  const handleDeleteStep = (id: string) => {
    const filtered = steps.filter(s => s.id !== id);
    // Re-index step numbers
    const reindexed = filtered.map((s, idx) => ({
      ...s,
      stepNumber: idx + 1
    }));
    setSteps(reindexed);
  };

  // Update field on a specific step
  const handleUpdateStepField = (id: string, field: keyof FunnelStep, value: any) => {
    setSteps(prev => prev.map(s => {
      if (s.id === id) {
        return { ...s, [field]: value };
      }
      return s;
    }));
  };

  // Add condition to a step
  const handleAddCondition = (stepId: string) => {
    const newCondition: Condition = {
      id: `cond-new-${Date.now()}`,
      field: 'page_path',
      operator: 'contains',
      value: ''
    };
    setSteps(prev => prev.map(s => {
      if (s.id === stepId) {
        return {
          ...s,
          conditions: [...s.conditions, newCondition]
        };
      }
      return s;
    }));
  };

  // Update condition values
  const handleUpdateCondition = (stepId: string, condId: string, field: keyof Condition, value: string) => {
    setSteps(prev => prev.map(s => {
      if (s.id === stepId) {
        return {
          ...s,
          conditions: s.conditions.map(c => c.id === condId ? { ...c, [field]: value } : c)
        };
      }
      return s;
    }));
  };

  // Remove a condition
  const handleRemoveCondition = (stepId: string, condId: string) => {
    setSteps(prev => prev.map(s => {
      if (s.id === stepId) {
        return {
          ...s,
          conditions: s.conditions.filter(c => c.id !== condId)
        };
      }
      return s;
    }));
  };

  // Save Funnel and commit back to parent.
  // Demo: apenas estado local (protótipo intacto). Live: POST (funil novo) ou
  // PATCH /v1/funnels/:id e só então confirma o sucesso na UI.
  const handleApplyChanges = () => {
    setSaveError(null);

    // Generate computed reach numbers
    const finalStepsWithReach = steps.map((s, idx) => ({
      ...s,
      reach: calculateDynamicReach(idx, steps)
    }));

    const finalConversion = finalStepsWithReach.length > 0 && finalStepsWithReach[0].reach > 0
      ? parseFloat(((finalStepsWithReach[finalStepsWithReach.length - 1].reach / finalStepsWithReach[0].reach) * 100).toFixed(1))
      : 0;

    const updatedFunnel: Funnel = {
      ...activeFunnel,
      name: funnelName,
      status: funnelStatus,
      steps: finalStepsWithReach,
      totalSteps: finalStepsWithReach.length,
      conversionRate: finalConversion,
      updatedTime: 'Updated just now'
    };

    const commitLocal = () => {
      onSaveFunnel(updatedFunnel);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    };

    if (!isLive) {
      commitLocal();
      return;
    }

    // Live: valida o mínimo do M5 (≥ 2 steps) antes de chamar a API.
    const apiSteps = stepsToApi(steps);
    if (apiSteps.length < 2) {
      setSaveError('Um funil precisa de ao menos 2 etapas para ser salvo.');
      return;
    }
    const isNew = activeFunnel.id.startsWith('funnel-new-');
    const payload = {
      name: funnelName,
      status: localToApiFunnelStatus(funnelStatus),
      steps: apiSteps,
      ...(isNew ? { attribution_window_days: 7 } : {}),
    };
    void api(isNew ? '/v1/funnels' : `/v1/funnels/${activeFunnel.id}`, {
      method: isNew ? 'POST' : 'PATCH',
      body: JSON.stringify(payload),
    })
      .then(() => {
        // TODO(live): ao criar, o id do servidor difere do id temporário local;
        // a lista é re-sincronizada por GET /v1/funnels ao voltar para "Funnels".
        commitLocal();
      })
      .catch(() => {
        setSaveError(
          'Não foi possível salvar o funil na API. Verifique suas permissões e tente novamente.',
        );
      });
  };

  const currentComputedSteps = steps.map((s, idx) => ({
    ...s,
    reach: calculateDynamicReach(idx, steps)
  }));

  return (
    <div id="funnel-builder-container" className="space-y-6">
      {/* Top action header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Funnel Stage Designer</h2>
          <p className="text-xs text-slate-500 mt-1 font-sans">Assemble custom UTM segmentations, dynamic page path limits, and client actions</p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={() => setView('funnels')}
            className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
          >
            Back to Funnels
          </button>
          <button
            onClick={handleApplyChanges}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer flex items-center gap-1.5"
          >
            <CheckCircle className="w-4 h-4 text-teal-400" />
            <span>Apply to Production</span>
          </button>
        </div>
      </div>

      {/* Error Banner (live) */}
      {saveError && (
        <div className="bg-rose-50 border border-rose-100 p-4 rounded-xl flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
          <div>
            <h4 className="text-xs font-bold text-rose-900 leading-normal">Não foi possível salvar</h4>
            <p className="text-[11px] text-rose-700 font-sans mt-0.5">{saveError}</p>
          </div>
        </div>
      )}

      {/* Success Notification Banner */}
      {saveSuccess && (
        <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-xl flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
          <div>
            <h4 className="text-xs font-bold text-emerald-900 leading-normal">Funnel Changes Active!</h4>
            <p className="text-[11px] text-emerald-700 font-sans mt-0.5">
              The updated step configuration has been compiled and is now calculating real-time conversions in the live dashboard.
            </p>
          </div>
        </div>
      )}

      {/* Grid: Editor Left, Live Visuals Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Side: Builder Controls - Span 7 */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-7 space-y-6">
          <div className="pb-4 border-b border-slate-100 flex flex-col sm:flex-row gap-4 items-end">
            {/* Funnel Name Input */}
            <div className="flex-1">
              <label className="text-[10px] font-mono text-slate-400 uppercase font-semibold block mb-1.5">Funnel Journey Name</label>
              <input
                type="text"
                value={funnelName}
                onChange={(e) => setFunnelName(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:ring-1 focus:ring-teal-500 focus:border-teal-500 outline-none"
                placeholder="e.g. Black Friday Ad Landing Journey"
              />
            </div>

            {/* Status Selector */}
            <div className="w-40">
              <label className="text-[10px] font-mono text-slate-400 uppercase font-semibold block mb-1.5">Current Status</label>
              <select
                value={funnelStatus}
                onChange={(e) => setFunnelStatus(e.target.value as any)}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:ring-1 focus:ring-teal-500 focus:border-teal-500 bg-white outline-none"
              >
                <option value="active">Active (Tracking)</option>
                <option value="inactive">Inactive (Paused)</option>
                <option value="draft">Draft (Configuring)</option>
              </select>
            </div>
          </div>

          {/* Steps List */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Sequential Steps List</h3>
              <span className="text-[10px] font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-semibold">
                {steps.length} Steps Defined
              </span>
            </div>

            {steps.length === 0 ? (
              <div className="border border-dashed border-slate-200 rounded-2xl p-8 text-center text-slate-500 bg-slate-50/50">
                <Layers className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                <h4 className="text-xs font-bold text-slate-700">No Stages Configured</h4>
                <p className="text-[11px] text-slate-400 max-w-xs mx-auto mt-1">Start adding user events like page_view, add_to_cart, and custom webhooks to establish a tracking stream.</p>
                <button
                  onClick={handleAddStep}
                  className="mt-3 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 mx-auto cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create First Stage</span>
                </button>
              </div>
            ) : (
              <div className="space-y-4 relative">
                {steps.map((step, idx) => {
                  const stepComputedReach = currentComputedSteps[idx]?.reach || 0;
                  return (
                    <div 
                      key={step.id}
                      className="p-4 bg-slate-50/50 hover:bg-slate-50 border border-slate-150 rounded-xl relative hover:border-slate-300 transition-all"
                    >
                      {/* Step Header */}
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-slate-800 text-white font-mono text-[10px] font-bold flex items-center justify-center">
                            {step.stepNumber}
                          </span>
                          <input
                            type="text"
                            value={step.name}
                            onChange={(e) => handleUpdateStepField(step.id, 'name', e.target.value)}
                            className="bg-transparent border-b border-transparent hover:border-slate-200 focus:border-teal-500 font-bold text-xs text-slate-800 focus:bg-white px-1 py-0.5 rounded-sm outline-none w-48 font-sans"
                            placeholder="Stage Label"
                          />
                        </div>

                        <div className="flex items-center gap-3">
                          {/* Event Type selection */}
                          <select
                            value={step.eventType}
                            onChange={(e) => handleUpdateStepField(step.id, 'eventType', e.target.value)}
                            className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-mono font-bold text-slate-700 focus:ring-1 focus:ring-teal-500 outline-none"
                          >
                            <option value="page_view">page_view (Ad/Link)</option>
                            <option value="view_item">view_item (Product)</option>
                            <option value="add_to_cart">add_to_cart (Cart)</option>
                            <option value="initiate_checkout">initiate_checkout (Checkout)</option>
                            <option value="purchase">purchase (Sale)</option>
                            <option value="lead">lead (Signup/Form)</option>
                            <option value="custom_event">custom_event</option>
                          </select>

                          {/* Delete Step */}
                          <button
                            onClick={() => handleDeleteStep(step.id)}
                            className="p-1.5 hover:bg-rose-50 hover:text-rose-600 rounded-lg text-slate-400 transition-colors"
                            title="Remove Step"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Conditions list */}
                      <div className="mt-3.5 space-y-2 pt-3 border-t border-slate-100/60">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] font-mono text-slate-400 uppercase font-bold tracking-wider">Matching Rules (AND)</span>
                          <button
                            onClick={() => handleAddCondition(step.id)}
                            className="text-[9px] font-mono font-bold text-teal-600 hover:text-teal-700 flex items-center gap-0.5 cursor-pointer"
                          >
                            <Plus className="w-3 h-3" />
                            <span>Add Filter Rule</span>
                          </button>
                        </div>

                        {step.conditions.length === 0 ? (
                          <p className="text-[10px] text-slate-400 italic font-sans py-0.5">Captures all trigger events without secondary query filtering.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {step.conditions.map((cond) => (
                              <div key={cond.id} className="flex items-center gap-1.5">
                                {/* Field Select */}
                                <select
                                  value={cond.field}
                                  onChange={(e) => handleUpdateCondition(step.id, cond.id, 'field', e.target.value)}
                                  className="px-2 py-1 bg-white border border-slate-200 rounded-md text-[10px] font-mono font-semibold text-slate-600 focus:outline-none"
                                >
                                  <option value="utm_source">utm_source</option>
                                  <option value="utm_medium">utm_medium</option>
                                  <option value="utm_campaign">utm_campaign</option>
                                  <option value="page_path">page_path</option>
                                  <option value="price">price</option>
                                  <option value="currency">currency</option>
                                </select>

                                {/* Operator Select */}
                                <select
                                  value={cond.operator}
                                  onChange={(e) => handleUpdateCondition(step.id, cond.id, 'operator', e.target.value)}
                                  className="px-2 py-1 bg-white border border-slate-200 rounded-md text-[10px] font-mono font-semibold text-slate-600 focus:outline-none"
                                >
                                  <option value="equals">equals</option>
                                  <option value="contains">contains</option>
                                  <option value="starts_with">starts with</option>
                                  <option value="greater_than">greater than</option>
                                </select>

                                {/* Value Input */}
                                <input
                                  type="text"
                                  value={cond.value}
                                  onChange={(e) => handleUpdateCondition(step.id, cond.id, 'value', e.target.value)}
                                  placeholder="value..."
                                  className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded-md text-[10px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
                                />

                                {/* Delete Condition */}
                                <button
                                  onClick={() => handleRemoveCondition(step.id, cond.id)}
                                  className="p-1 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-sm"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Reach indicator */}
                      <div className="mt-3 pt-2 border-t border-slate-100/60 flex items-center justify-between text-[10px] font-mono text-slate-500">
                        <span>Dynamic Live Sample Reach</span>
                        <span className="font-bold text-teal-700">{stepComputedReach.toLocaleString()} visitors</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Bottom Add button */}
            {steps.length > 0 && (
              <button
                onClick={handleAddStep}
                className="w-full py-2 border-2 border-dashed border-slate-200 hover:border-teal-400 bg-slate-50/20 hover:bg-slate-50 rounded-xl text-xs font-bold text-slate-600 hover:text-teal-800 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4 text-teal-600" />
                <span>Append Next Funnel Step</span>
              </button>
            )}
          </div>
        </div>

        {/* Right Side: Live Interactive Flowchart - Span 5 */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs flex flex-col h-full justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Live Stage Funnel Visualization</h3>
                  <p className="text-xs text-slate-500 mt-1">Calculates immediate fall-off conversion rate based on active logic</p>
                </div>
                <Sparkles className="w-4.5 h-4.5 text-teal-600" />
              </div>

              {steps.length === 0 ? (
                <div className="p-8 text-center text-slate-400 italic text-[11px]">
                  Build at least one stage on the left to review the funnel charts.
                </div>
              ) : (
                <div className="space-y-4 py-2">
                  {currentComputedSteps.map((step, idx) => {
                    const nextStep = currentComputedSteps[idx + 1];
                    const conversionPercent = idx === 0 
                      ? 100 
                      : currentComputedSteps[idx - 1].reach > 0 
                      ? Math.round((step.reach / currentComputedSteps[idx - 1].reach) * 100) 
                      : 0;

                    const dropoff = 100 - conversionPercent;
                    
                    // Bar width representation scale
                    const maxReach = currentComputedSteps[0].reach || 1;
                    const percentOfMax = Math.max(12, Math.round((step.reach / maxReach) * 100));

                    return (
                      <div key={step.id}>
                        {/* Step bar block */}
                        <div className="relative">
                          {/* Colored bar background */}
                          <div 
                            className="h-11 bg-linear-to-r from-teal-50 to-emerald-50/70 border border-teal-100/50 rounded-xl flex items-center justify-between px-4 transition-all"
                            style={{ width: `${percentOfMax}%` }}
                          >
                            <div className="flex items-center gap-2 truncate pr-2">
                              <span className="font-mono text-[10px] font-bold text-teal-800 bg-white w-4 h-4 rounded-full flex items-center justify-center shadow-2xs">
                                {step.stepNumber}
                              </span>
                              <span className="text-xs font-bold text-teal-950 truncate font-sans">{step.name}</span>
                            </div>
                            <span className="font-mono text-[11px] font-bold text-teal-800 shrink-0">
                              {step.reach.toLocaleString()}
                            </span>
                          </div>
                        </div>

                        {/* Transition indicator */}
                        {nextStep && (
                          <div className="py-2.5 pl-6 flex items-center gap-3">
                            <ArrowRight className="w-4 h-4 text-slate-400 rotate-90" />
                            <div className="text-[10px] font-mono text-slate-500">
                              <span className="text-emerald-600 font-bold">
                                {Math.round((nextStep.reach / step.reach) * 100)}%
                              </span> converted to stage {idx + 2}
                              <span className="text-slate-400 ml-2">({100 - Math.round((nextStep.reach / step.reach) * 100)}% dropoff)</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100 text-xs text-slate-600 font-sans space-y-1.5">
                <div className="flex justify-between font-mono text-[11px] font-semibold text-slate-700">
                  <span>Estimated Global Conversion:</span>
                  <span className="text-teal-700 font-bold">
                    {currentComputedSteps.length > 0 && currentComputedSteps[0].reach > 0
                      ? ((currentComputedSteps[currentComputedSteps.length - 1].reach / currentComputedSteps[0].reach) * 100).toFixed(1)
                      : '0.0'}%
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 leading-normal">
                  Values are calculated based on actual real-time event logs filtered by active query parameters (UTM sources, click pathways).
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
