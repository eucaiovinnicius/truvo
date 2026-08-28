import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { WorkspacesService } from '../auth/workspaces.service';
import { ConnectorConnectionService } from '../connectors/connector-connection.service';
import { EventContextQualityService } from '../data-quality/event-context-quality.service';
import { RadarService } from '../radars/radar.service';
import type { CreateFirstRadarDto, SelectPathDto } from './onboarding.dto';

type Progress = Record<string, unknown> & { workspace_id: string; selected_path?: string | null; connection_id?: string | null; first_radar_id?: string | null; started_at?: Date | null; first_radar_created_at?: Date | null };
const SAFE_METADATA = new Set(['path', 'provider', 'sourceStatus']);

@Injectable()
export class OnboardingService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly workspaces: WorkspacesService, private readonly connections: ConnectorConnectionService, private readonly quality: EventContextQualityService, private readonly radars: RadarService) {}

  private async ensure(workspaceId: string): Promise<Progress> {
    await this.db.execute(sql`insert into onboarding_progress (workspace_id) values (${workspaceId}) on conflict (workspace_id) do nothing`);
    const [row] = await this.db.execute(sql`select * from onboarding_progress where workspace_id=${workspaceId}`);
    return row as Progress;
  }

  private async milestone(workspaceId: string, userId: string | undefined, name: string, metadata: Record<string, unknown> = {}) {
    const safe = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => SAFE_METADATA.has(key) && ['string', 'number', 'boolean'].includes(typeof value)));
    await this.db.execute(sql`insert into onboarding_milestones (workspace_id,user_id,milestone,metadata) values (${workspaceId},${userId ?? null},${name},${JSON.stringify(safe)}::jsonb) on conflict (workspace_id,milestone) do nothing`);
  }

  private async source(workspaceId: string, progress: Progress) {
    if (progress.selected_path === 'custom') return { state: 'custom', healthy: true, provider: 'truvo_events' };
    if (!progress.connection_id) return { state: 'not_connected', healthy: false, provider: null };
    try {
      const connection = await this.connections.get(workspaceId, String(progress.connection_id));
      const healthy = connection.lifecycleState === 'healthy' && connection.credentialStatus === 'valid';
      const blocked = connection.lifecycleState === 'disconnected' || ['invalid', 'expired'].includes(connection.credentialStatus);
      return { state: healthy ? 'healthy' : blocked ? 'error' : connection.lifecycleState, healthy, provider: connection.provider };
    } catch { return { state: 'removed', healthy: false, provider: null }; }
  }

  async get(workspaceId: string) {
    const progress = await this.ensure(workspaceId); const source = await this.source(workspaceId, progress);
    if (progress.connection_id && !source.healthy && progress.first_radar_id) await this.db.execute(sql`update onboarding_progress set status='blocked',source_status=${source.state},last_error_code='source_unhealthy',last_error_remediation='Reconnect or replace the context source',updated_at=now() where workspace_id=${workspaceId}`);
    const [fresh] = await this.db.execute(sql`select * from onboarding_progress where workspace_id=${workspaceId}`);
    const milestones = await this.db.execute(sql`select milestone,metadata,occurred_at from onboarding_milestones where workspace_id=${workspaceId} order by occurred_at`);
    const p = fresh as Progress;
    const ttfvMs = p.started_at && p.first_radar_created_at ? new Date(p.first_radar_created_at).getTime() - new Date(p.started_at).getTime() : null;
    return { progress: p, source, milestones, ttfvMs, recommendations: { ecommerce: ['shopify', 'stripe', 'klaviyo'], saas: ['stripe', 'hubspot', 'klaviyo'], custom: ['truvo_events', 'api_ingestion'] } };
  }

  async start(workspaceId: string, userId: string | undefined, workspaceName?: string) {
    if (workspaceName) await this.workspaces.update(workspaceId, { name: workspaceName });
    await this.ensure(workspaceId);
    await this.db.execute(sql`update onboarding_progress set status=case when status='not_started' then 'in_progress' else status end,current_step=case when current_step='workspace_basics' then 'choose_path' else current_step end,started_at=coalesce(started_at,now()),updated_at=now() where workspace_id=${workspaceId}`);
    await this.milestone(workspaceId, userId, 'onboarding_started'); return this.get(workspaceId);
  }

  async selectPath(workspaceId: string, userId: string | undefined, input: SelectPathDto) {
    await this.ensure(workspaceId);
    await this.db.execute(sql`update onboarding_progress set selected_path=${input.path},status='waiting_for_connection',current_step='connect_context',connection_id=null,source_status='not_connected',last_error_code=null,last_error_remediation=null,updated_at=now() where workspace_id=${workspaceId}`);
    await this.milestone(workspaceId, userId, 'onboarding_path_selected', { path: input.path }); return this.get(workspaceId);
  }

  async linkConnection(workspaceId: string, userId: string | undefined, connectionId: string) {
    const progress = await this.ensure(workspaceId); if (!progress.selected_path) throw new ConflictException('Choose a data path first');
    await this.milestone(workspaceId, userId, 'context_connection_started', { path: progress.selected_path });
    let connection;
    try { connection = await this.connections.get(workspaceId, connectionId); }
    catch (error) { await this.milestone(workspaceId, userId, 'context_connection_failed'); throw error; }
    const healthy = connection.lifecycleState === 'healthy' && connection.credentialStatus === 'valid';
    await this.db.execute(sql`update onboarding_progress set connection_id=${connectionId},source_status=${healthy ? 'healthy' : connection.lifecycleState},status=${healthy ? 'waiting_for_data' : 'syncing'},current_step='verify_data',healthy_context_at=case when ${healthy} then coalesce(healthy_context_at,now()) else healthy_context_at end,last_error_code=${healthy ? null : 'source_not_ready'},last_error_remediation=${healthy ? null : 'Finish authorization and wait for the initial sync'},updated_at=now() where workspace_id=${workspaceId}`);
    await this.milestone(workspaceId, userId, healthy ? 'context_connection_succeeded' : 'context_connection_failed', { provider: connection.provider, sourceStatus: healthy ? 'healthy' : connection.lifecycleState });
    return this.get(workspaceId);
  }

  async verifyData(workspaceId: string, userId?: string) {
    const progress = await this.ensure(workspaceId); const source = await this.source(workspaceId, progress);
    if (progress.selected_path !== 'custom' && !source.healthy) {
      await this.db.execute(sql`update onboarding_progress set status='blocked',source_status=${source.state},last_error_code='source_unhealthy',last_error_remediation='Retry sync or reconnect the source',updated_at=now() where workspace_id=${workspaceId}`);
      return this.get(workspaceId);
    }
    const [row] = await this.db.execute(sql`select (select count(*) from customers where workspace_id=${workspaceId} and deleted_at is null) as customers,(select count(*) from customer_outcomes where workspace_id=${workspaceId}) as outcomes,(select count(*) from engagement_events where workspace_id=${workspaceId}) as events`);
    const counts = Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, Number(v)])); const detected = Object.values(counts).some((v) => v > 0);
    await this.db.execute(sql`update onboarding_progress set status=${detected ? 'data_detected' : 'waiting_for_data'},current_step=${detected ? 'readiness' : 'verify_data'},data_verified_at=case when ${detected} then coalesce(data_verified_at,now()) else data_verified_at end,last_error_code=${detected ? null : 'no_incoming_data'},last_error_remediation=${detected ? null : 'Send a real event or wait for the initial connector sync'},updated_at=now() where workspace_id=${workspaceId}`);
    if (detected) await this.milestone(workspaceId, userId, 'incoming_data_verified');
    return { ...(await this.get(workspaceId)), counts, detected };
  }

  async readiness(workspaceId: string, userId: string | undefined, request: { outcomeNamespace?: string; outcomeKey?: string; historicalWindowDays?: number }) {
    const progress = await this.ensure(workspaceId); if (!progress.data_verified_at) throw new ConflictException('Verify incoming data first');
    const result = await this.quality.evaluate(workspaceId, request);
    await this.db.execute(sql`update onboarding_progress set status='readiness_available',current_step='create_radar',readiness_viewed_at=coalesce(readiness_viewed_at,now()),updated_at=now() where workspace_id=${workspaceId}`);
    await this.milestone(workspaceId, userId, 'readiness_viewed'); return { ...(await this.get(workspaceId)), readiness: result };
  }

  async createFirstRadar(workspaceId: string, userId: string | undefined, input: CreateFirstRadarDto) {
    const { idempotencyKey, ...radarInput } = input;
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`onboarding:${workspaceId}`}))`);
      const [p] = await tx.execute(sql`select * from onboarding_progress where workspace_id=${workspaceId} for update`);
      const progress = p as Progress | undefined; if (!progress?.readiness_viewed_at) throw new ConflictException('Review readiness first');
      if (progress.first_radar_id) return { radar: await this.radars.get(workspaceId, String(progress.first_radar_id)), replay: true };
      if (progress.radar_idempotency_key && progress.radar_idempotency_key !== idempotencyKey) throw new ConflictException('First Radar creation is already in progress');
      await tx.execute(sql`update onboarding_progress set status='radar_in_progress',first_radar_initiated_at=coalesce(first_radar_initiated_at,now()),radar_idempotency_key=${idempotencyKey},updated_at=now() where workspace_id=${workspaceId}`);
      const created = await this.radars.create(workspaceId, radarInput);
      const createdId = String((created as { radar?: { id?: string } }).radar?.id);
      await this.radars.validate(workspaceId, createdId);
      const radar = await this.radars.get(workspaceId, createdId);
      const radarId = String((radar as { radar?: { id?: string } }).radar?.id);
      await tx.execute(sql`update onboarding_progress set status='completed',current_step='completed',first_radar_id=${radarId},first_radar_created_at=coalesce(first_radar_created_at,now()),completed_at=coalesce(completed_at,now()),last_error_code=null,last_error_remediation=null,updated_at=now() where workspace_id=${workspaceId}`);
      return { radar, replay: false };
    });
    await this.milestone(workspaceId, userId, 'first_radar_initiated');
    await this.milestone(workspaceId, userId, 'first_radar_created'); await this.milestone(workspaceId, userId, 'onboarding_completed');
    return { ...(await this.get(workspaceId)), ...result };
  }
}
