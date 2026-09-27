/**
 * ORDER 130 — SPEC-21: QA & Workspace de Demonstração v1
 * Types and contracts for deterministic synthetic dataset, connector fixtures,
 * tenant isolation, and golden E2E journey.
 */

export type PersonaType =
  | 'likely_buyer'
  | 'non_buyer'
  | 'repeat_buyer'
  | 'subscription_upgrade_candidate'
  | 'churn_like_history'
  | 'insufficient_history';

export interface PersonaDefinition {
  type: PersonaType;
  name: string;
  description: string;
  expectedPropensityBand: 'high' | 'medium' | 'low' | 'unscored';
  expectedPropensityScore: number | null;
  customer: {
    id: string;
    externalId: string;
    email: string;
    phone?: string;
    status: 'identified' | 'anonymous';
    anonymousId?: string;
  };
  traits: Array<{
    namespace: string;
    key: string;
    valueType: 'string' | 'number' | 'boolean' | 'datetime' | 'json';
    value: string | number | boolean | Record<string, unknown>;
  }>;
  orders?: Array<{
    id: string;
    providerOrderId: string;
    financialStatus: 'paid' | 'pending' | 'refunded' | 'partially_refunded';
    currency: string;
    totalAmount: string;
    processedAt: string;
    lineItems: Array<{
      productId: string;
      variantId?: string;
      title: string;
      quantity: number;
      unitPrice: string;
    }>;
  }>;
  subscriptions?: Array<{
    id: string;
    providerSubscriptionId: string;
    status: 'active' | 'canceled' | 'past_due' | 'trialing';
    currency: string;
    currentPeriodEnd: string;
    plan: string;
    amount: string;
  }>;
  engagementEvents?: Array<{
    providerEventId: string;
    metricName: string;
    engagementKind: 'received' | 'delivery' | 'opened' | 'clicked' | 'bounced' | 'unsubscribed' | 'marked_spam' | 'other';
    occurredAt: string;
    properties?: Record<string, unknown>;
  }>;
  identityTransition?: {
    anonymousCustomerId: string;
    anonymousIdentifierValue: string;
    transitionedAt: string;
    reason: string;
  };
}

export interface SyntheticDatasetV1 {
  version: '1.0.0';
  fixedClock: string;
  personas: Record<PersonaType, PersonaDefinition>;
  products: Array<{
    id: string;
    title: string;
    category: string;
    price: string;
    currency: string;
  }>;
  accounts: Array<{
    id: string;
    name: string;
    domain: string;
    tier: string;
  }>;
  targetOutcomes: Array<{
    id: string;
    outcomeNamespace: string;
    outcomeKey: string;
    name: string;
    kind: 'event' | 'metric';
  }>;
}

export interface DemoWorkspaceSeedResult {
  workspaceId: string;
  workspaceSlug: string;
  seededAt: string;
  datasetVersion: string;
  personas: Record<PersonaType, { customerId: string; externalId: string }>;
  entityCounts: {
    customers: number;
    traits: number;
    identifiers: number;
    orders: number;
    subscriptions: number;
    engagementEvents: number;
    identityMerges: number;
  };
  radar: {
    id: string;
    name: string;
    status: string;
    definitionVersion: number;
    modelVersionId: string;
    scoreBatchId: string;
  };
  opportunityBatchId: string;
  decisionBatchId: string;
}

export interface DemoWorkspaceOptions {
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  operatorUserId?: string;
  cleanBeforeSeed?: boolean;
}
