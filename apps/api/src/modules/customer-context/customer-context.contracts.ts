import type {
  Customer,
  CustomerIdentifier,
  CustomerRelationship,
  CustomerTrait,
  CustomerTraitValueType,
} from '@truvo/db';

export type TypedTraitValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'datetime'; value: string }
  | { type: 'json'; value: unknown };

export type TraitWrite = TypedTraitValue & {
  workspaceId: string;
  customerId: string;
  traitNamespace: string;
  traitKey: string;
  sourceNamespace: string;
  observedAt: Date;
  expiresAt?: Date | null;
  provenance?: Record<string, unknown>;
};

export interface CustomerBehaviorReference {
  store: 'clickhouse';
  dataset: 'events';
  workspace_id: string;
  customer_id: string;
  legacy_canonical_id: string | null;
}

export interface CustomerContext {
  customer: Customer;
  identifiers: CustomerIdentifier[];
  current_traits: CustomerTrait[];
  relationships: CustomerRelationship[];
  behavior_references: CustomerBehaviorReference[];
  context_references: Array<{
    kind: 'legacy_profile' | 'identity_graph';
    workspace_id: string;
    reference_id: string;
  }>;
}

export interface TraitWriteResult {
  accepted: boolean;
  current: CustomerTrait;
}

export function assertNamespace(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`${field} must be a non-empty provider namespace`);
  }
  return normalized;
}

export function normalizeTraitValue(input: TypedTraitValue): unknown {
  switch (input.type) {
    case 'string':
      return input.value;
    case 'number':
      if (!Number.isFinite(input.value)) throw new Error('number trait must be finite');
      return input.value;
    case 'boolean':
      return input.value;
    case 'datetime': {
      const parsed = new Date(input.value);
      if (Number.isNaN(parsed.getTime())) throw new Error('datetime trait must be ISO-8601 compatible');
      return parsed.toISOString();
    }
    case 'json':
      if (input.value === undefined) throw new Error('json trait cannot be undefined');
      return input.value;
  }
}

export function traitType(input: TypedTraitValue): CustomerTraitValueType {
  return input.type;
}
