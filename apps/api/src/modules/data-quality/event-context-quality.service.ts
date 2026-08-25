import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, type Database } from '../auth/database.provider';

export type QualityDimension = 'identity' | 'events' | 'commerce' | 'crm' | 'billing' | 'engagement' | 'acquisition' | 'outcomes';
export interface EventQualityInput { eventName?: unknown; identifiers?: Record<string, unknown>; properties?: Record<string, unknown>; timestamp?: unknown; naturalId?: unknown; }
export interface EventQualityOptions { knownEventNames?: string[]; requiredProperties?: Record<string, 'string' | 'number' | 'boolean' | 'object'>; observedProperties?: string[]; }
export interface QualityIssueInput { stableKey: string; category: string; severity: 'info' | 'warning' | 'blocker' | 'critical'; actionCode?: string; details?: Record<string, unknown>; sampleContext?: Record<string, unknown>; sourceNamespace?: string; connectionId?: string; streamKey?: string; entityType?: string; entityId?: string; eventName?: string; }

const SECRET = /token|secret|password|authorization|credential|api[_-]?key|email|phone/i;
export function redactSample(value: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET.test(key)).slice(0, 20));
}
export function validateEventQuality(event: EventQualityInput, options: EventQualityOptions = {}): QualityIssueInput[] {
  const issues: QualityIssueInput[] = [];
  if (!event.identifiers || Object.values(event.identifiers).every((v) => v == null || String(v).trim() === '')) issues.push({ stableKey: 'event:missing_identifier', category: 'event', severity: 'blocker', actionCode: 'improve_identity_capture' });
  const name = typeof event.eventName === 'string' ? event.eventName.trim() : '';
  if (!name) issues.push({ stableKey: 'event:unknown_name', category: 'schema_drift', severity: 'blocker', actionCode: 'map_event' });
  else if (options.knownEventNames && !options.knownEventNames.includes(name)) issues.push({ stableKey: `event:unknown_name:${name}`, category: 'schema_drift', severity: 'warning', eventName: name, actionCode: 'map_event' });
  for (const [key, type] of Object.entries(options.requiredProperties ?? {})) {
    const value = event.properties?.[key];
    const valid = value !== undefined && value !== null && ((type === 'string' && typeof value === 'string') || (type === 'number' && typeof value === 'number' && Number.isFinite(value)) || (type === 'boolean' && typeof value === 'boolean') || (type === 'object' && typeof value === 'object'));
    if (!valid) issues.push({ stableKey: `event:missing_property:${name}:${key}`, category: 'schema_drift', severity: 'blocker', eventName: name || undefined, actionCode: 'map_field', details: { field: key, expectedType: type } });
  }
  if (options.observedProperties && event.properties) for (const key of Object.keys(event.properties)) if (!options.observedProperties.includes(key)) issues.push({ stableKey: `event:new_field:${name}:${key}`, category: 'schema_drift', severity: 'info', actionCode: 'resolve_schema_drift', details: { field: key, recommendation: `map provider field ${key} to an approved canonical field` } });
  if (event.timestamp) { const ts = new Date(String(event.timestamp)).getTime(); if (!Number.isFinite(ts) || ts > Date.now() + 5 * 60_000 || ts < Date.now() - 366 * 24 * 60 * 60_000) issues.push({ stableKey: `event:timestamp_anomaly:${name}`, category: 'event', severity: 'warning', eventName: name, actionCode: 'fix_tracking' }); }
  return issues;
}

function count(row: unknown): number { return Number((row as { count?: string })?.count ?? 0); }
@Injectable()
export class EventContextQualityService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async evaluate(workspaceId: string, request: { requiredDimensions?: QualityDimension[]; outcomeNamespace?: string; outcomeKey?: string; historicalWindowDays?: number } = {}) {
    const now = new Date();
    const [eligibleRow] = await this.db.execute(sql`select count(*)::int as count from customers where workspace_id=${workspaceId} and deleted_at is null and status <> 'merged'`);
    const [identityRow] = await this.db.execute(sql`select count(distinct c.id)::int as count from customers c join customer_identifiers i on i.workspace_id=c.workspace_id and i.customer_id=c.id where c.workspace_id=${workspaceId} and c.deleted_at is null and i.deleted_at is null`);
    const eligible = count(eligibleRow); const identity = count(identityRow);
    const dimensions: Record<string, { eligible: number; observed: number; coverage: number | null }> = {};
    const tables: Record<string, string> = { events: 'engagement_events', commerce: 'commerce_orders', billing: 'billing_context_subscriptions', engagement: 'engagement_events' };
    dimensions.identity = { eligible, observed: identity, coverage: eligible ? identity / eligible : null };
    for (const [dimension, table] of Object.entries(tables)) { const [r] = await this.db.execute(sql.raw(`select count(distinct customer_id)::int as count from ${table} where workspace_id = '${workspaceId.replace(/'/g, "''")}' and customer_id is not null`)); const observed = count(r); dimensions[dimension] = { eligible, observed, coverage: eligible ? observed / eligible : null }; }
    const [crmRow] = await this.db.execute(sql`select count(*)::int as count from crm_accounts where workspace_id=${workspaceId} and deleted_at is null`); dimensions.crm = { eligible, observed: count(crmRow), coverage: eligible ? count(crmRow) / eligible : null };
    const [outcomeRow] = await this.db.execute(sql`select count(*)::int as count from customer_outcomes where workspace_id=${workspaceId}`); const outcomes = count(outcomeRow);
    dimensions.outcomes = { eligible, observed: outcomes, coverage: eligible ? Math.min(1, outcomes / eligible) : null };
    dimensions.acquisition = { eligible, observed: 0, coverage: null };
    const issues: QualityIssueInput[] = [];
    if (eligible > 0 && identity / eligible < 0.5 && !(request.requiredDimensions ?? []).includes('identity')) issues.push({ stableKey: 'context:low_identity_coverage', category: 'context', severity: 'warning', actionCode: 'improve_identity_capture', details: { coverage: identity / eligible } });
    for (const dimension of request.requiredDimensions ?? []) if ((dimensions[dimension]?.coverage ?? 0) < 1) issues.push({ stableKey: `context:required:${dimension}`, category: 'context', severity: 'blocker', actionCode: `improve_${dimension}_coverage`, details: { dimension, coverage: dimensions[dimension]?.coverage } });
    const connections = await this.db.execute(sql`select id, provider, lifecycle_state, credential_status, last_sync_at from connector_connections where workspace_id=${workspaceId} and role <> 'destination'`);
    const freshness: Record<string, unknown>[] = [];
    for (const c of connections as unknown as Array<{ id: string; provider: string; lifecycle_state: string; credential_status: string; last_sync_at: Date | null }>) {
      const key = `${c.provider}:${c.id}`; const age = c.last_sync_at ? now.getTime() - new Date(c.last_sync_at).getTime() : Infinity;
      if (['disconnected'].includes(c.lifecycle_state) || ['invalid', 'expired'].includes(c.credential_status)) issues.push({ stableKey: `source:disconnected:${c.id}`, category: 'source', severity: 'blocker', connectionId: c.id, sourceNamespace: c.provider, actionCode: 'reconnect_source' });
      else if (age > 48 * 60 * 60_000) issues.push({ stableKey: `source:stale:${c.id}`, category: 'freshness', severity: 'warning', connectionId: c.id, sourceNamespace: c.provider, actionCode: 'wait_for_backfill', details: { ageHours: Math.round(age / 3600000) } });
      freshness.push({ connectionId: c.id, provider: c.provider, state: c.lifecycle_state, ageHours: Number.isFinite(age) ? Math.round(age / 3600000) : null });
    }
    const critical = issues.filter((i) => i.severity === 'blocker' || i.severity === 'critical').length; const warnings = issues.filter((i) => i.severity === 'warning').length;
    await this.persistIssues(workspaceId, issues);
    const dataHealthScore = Math.max(0, Math.min(100, 100 - critical * 30 - warnings * 10));
    const contextCoverageScore = eligible ? Math.round(Object.values(dimensions).filter((d) => d.coverage != null).reduce((sum, d) => sum + (d.coverage ?? 0), 0) / Object.values(dimensions).filter((d) => d.coverage != null).length * 100) : 0;
    const historyDays = request.historicalWindowDays ?? 0; const readiness = { status: critical === 0 && eligible > 0 && (!request.outcomeKey || outcomes > 0) ? 'ready' : 'not_ready', eligibleCustomerCount: eligible, labeledOutcomeCount: outcomes, positiveOutcomeCount: null, historicalWindowDays: historyDays, identityCoverage: eligible ? identity / eligible : null, requiredDimensions: request.requiredDimensions ?? [], sourceFreshness: freshness, blockingIssues: critical, warnings, reasonCodes: critical ? ['blocking_quality_issues'] : (!request.outcomeKey || outcomes > 0 ? [] : ['insufficient_outcome_history']), actionCodes: critical ? issues.filter((i) => i.actionCode).map((i) => i.actionCode) : [] };
    await this.db.execute(sql`insert into quality_evaluations (workspace_id, evaluated_at, data_health_score, data_health_status, context_coverage_score, identity_coverage, dimensions, source_freshness, duplicate_summary, critical_count, warnings_count, radar_readiness, updated_at) values (${workspaceId}, now(), ${dataHealthScore}, ${critical ? 'blocker' : warnings ? 'warning' : 'healthy'}, ${contextCoverageScore}, ${eligible ? Math.round(identity / eligible * 100) : 0}, ${JSON.stringify(dimensions)}::jsonb, ${JSON.stringify(freshness)}::jsonb, ${JSON.stringify({ duplicateDelivery: 'deduplicated', canonicalDefects: 0 })}::jsonb, ${critical}, ${warnings}, ${JSON.stringify(readiness)}::jsonb, now()) on conflict (workspace_id) do update set evaluated_at=excluded.evaluated_at, data_health_score=excluded.data_health_score, data_health_status=excluded.data_health_status, context_coverage_score=excluded.context_coverage_score, identity_coverage=excluded.identity_coverage, dimensions=excluded.dimensions, source_freshness=excluded.source_freshness, critical_count=excluded.critical_count, warnings_count=excluded.warnings_count, radar_readiness=excluded.radar_readiness, updated_at=now()`);
    return { dataHealth: { score: dataHealthScore, status: critical ? 'blocker' : warnings ? 'warning' : 'healthy', rules: { blockerPenalty: 30, warningPenalty: 10 } }, contextCoverage: { score: contextCoverageScore, dimensions }, identityCoverage: eligible ? identity / eligible : null, sourceFreshness: freshness, issues, criticalCount: critical, warningsCount: warnings, evaluatedAt: now.toISOString(), radarReadiness: readiness };
  }
  private async persistIssues(workspaceId: string, issues: QualityIssueInput[]) { const seen = new Set(issues.map((i) => i.stableKey)); for (const issue of issues) await this.db.execute(sql`insert into quality_issues (workspace_id,id,stable_key,category,severity,status,source_namespace,connection_id,stream_key,entity_type,entity_id,event_name,sample_context,action_code,details,first_seen_at,last_seen_at,occurrence_count,updated_at) values (${workspaceId},${randomUUID()},${issue.stableKey},${issue.category},${issue.severity},'active',${issue.sourceNamespace ?? null},${issue.connectionId ?? null},${issue.streamKey ?? null},${issue.entityType ?? null},${issue.entityId ?? null},${issue.eventName ?? null},${JSON.stringify(redactSample(issue.sampleContext))}::jsonb,${issue.actionCode ?? null},${JSON.stringify(issue.details ?? {})}::jsonb,now(),now(),1,now()) on conflict (workspace_id,stable_key) do update set severity=excluded.severity,status='active',last_seen_at=now(),occurrence_count=quality_issues.occurrence_count+1,resolved_at=null,updated_at=now()`); const active = await this.db.execute(sql`select stable_key from quality_issues where workspace_id=${workspaceId} and status='active'`); for (const row of active as unknown as Array<{ stable_key: string }>) if (!seen.has(row.stable_key)) await this.db.execute(sql`update quality_issues set status='resolved', resolved_at=now(), updated_at=now() where workspace_id=${workspaceId} and stable_key=${row.stable_key}`); }
  async getSummary(workspaceId: string) { const [row] = await this.db.execute(sql`select * from quality_evaluations where workspace_id=${workspaceId}`); return row ?? (await this.evaluate(workspaceId)); }
  async listIssues(workspaceId: string, status?: string) { return this.db.execute(status ? sql`select * from quality_issues where workspace_id=${workspaceId} and status=${status} order by last_seen_at desc` : sql`select * from quality_issues where workspace_id=${workspaceId} order by last_seen_at desc`); }
  async getIssue(workspaceId: string, issueId: string) { const [row] = await this.db.execute(sql`select * from quality_issues where workspace_id=${workspaceId} and id=${issueId}`); return row ?? null; }
}
