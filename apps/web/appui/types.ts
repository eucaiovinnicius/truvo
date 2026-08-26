export type ViewState =
  | 'onboarding'
  | 'dashboard'
  | 'funnels'
  | 'funnel-builder'
  | 'attribution'
  | 'creatives'
  | 'explorer'
  | 'ai'
  | 'profiles'
  | 'data-quality'
  | 'radars'
  | 'reports'
  | 'tracking'
  | 'integrations'
  | 'billing'
  | 'settings';

export interface Condition {
  id: string;
  field: string;
  operator: string;
  value: string;
}

export interface FunnelStep {
  id: string;
  stepNumber: number;
  name: string;
  eventType: string;
  conditions: Condition[];
  reach: number;
}

export interface Funnel {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'draft';
  conversionRate: number;
  totalSteps: number;
  steps: FunnelStep[];
  updatedTime: string;
  sparklineData: number[];
}

export interface CampaignRow {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  spend: number;
  rcas: number;
  roas_reported: number;
  roas_model: number;
  orders: number;
  cv: number;
  cpa: number;
  aov: number;
  ncRoas: number;
  atc: number;
  catc: number;
  isExpanded?: boolean;
  childRows?: CampaignRow[];
}

export interface Integration {
  id: string;
  name: string;
  icon: string;
  status: 'syncing' | 'connected' | 'auth_error';
  details: string;
  lastSync: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  status: 'active' | 'inactive';
}

export interface WorkspaceConfig {
  name: string;
  slug: string;
  timezone: string;
  currency: 'USD' | 'EUR' | 'BRL';
}

export interface ProfileConfig {
  fullName: string;
  email: string;
  avatarUrl: string;
}
