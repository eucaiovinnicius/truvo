import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';
import { ModelArtifactIntegrityService, type ArtifactIntegrityVerifier, type StoredModelArtifact } from './model-artifact-integrity.service';

type Model = StoredModelArtifact & { id: string; workspace_id: string; radar_id: string; definition_version: number; status: string; model_role: string; target_outcome_definition_id: string; prediction_window_days: number; feature_schema_version: string; verified_at: Date; promoted_at: Date | null; metrics: unknown; calibration: unknown; provenance: unknown; validation: unknown; created_at: Date };
type TrainingResult = { status: 'succeeded' | 'failed' | 'insufficient_data'; modelReference?: string; failureCategory?: string; failureReason?: string };

@Injectable()
export class ModelRegistryService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly audit: AuditService, private readonly artifacts: ModelArtifactIntegrityService) {}

  async list(workspaceId: string, radarId: string) {
    await this.radar(workspaceId, radarId);
    return this.db.execute(sql`select id,radar_id,definition_version,model_role,status,estimator_type,feature_schema_version,target_outcome_definition_id,prediction_window_days,metrics,calibration,provenance,validation,verified_at,promoted_at,created_at from radar_model_versions where workspace_id=${workspaceId} and radar_id=${radarId} order by created_at desc`);
  }
  async detail(workspaceId: string, radarId: string, modelId: string) {
    const [row] = await this.db.execute(sql`select id,radar_id,definition_version,model_role,status,estimator_type,feature_schema_version,target_outcome_definition_id,prediction_window_days,metrics,calibration,provenance,validation,verified_at,promoted_at,created_at from radar_model_versions where workspace_id=${workspaceId} and radar_id=${radarId} and id=${modelId}`);
    if (!row) throw new NotFoundException('Model not found'); return row;
  }
  async active(workspaceId: string, radarId: string) { await this.radar(workspaceId, radarId); const [row] = await this.db.execute(sql`select * from radar_model_versions where workspace_id=${workspaceId} and radar_id=${radarId} and model_role='propensity' and status='active'`); return row ?? null; }
  async latestTrainingRun(workspaceId: string, radarId: string) { await this.radar(workspaceId, radarId); const [row] = await this.db.execute(sql`select id,status,model_reference,failure_category,failure_reason,attempt_count,created_at,terminal_at,updated_at from radar_training_requests where workspace_id=${workspaceId} and radar_id=${radarId} order by created_at desc limit 1`); return row ?? null; }

  async reportTrainingResult(workspaceId: string, radarId: string, version: number, requestId: string, result: TrainingResult) {
    return this.db.transaction(async (tx) => {
      const [radar] = await tx.execute(sql`select * from radars where workspace_id=${workspaceId} and id=${radarId} for update`);
      if (!radar) throw new NotFoundException('Radar not found');
      const [request] = await tx.execute(sql`select * from radar_training_requests where workspace_id=${workspaceId} and id=${requestId} and radar_id=${radarId} and definition_version=${version} for update`);
      if (!request) throw new BadRequestException('Training request does not match Radar definition');
      const terminal = ['succeeded','failed','insufficient_data'].includes(String(request.status));
      if (terminal) {
        if (request.status === result.status && (result.status !== 'succeeded' || request.model_reference === result.modelReference?.trim())) return;
        throw new BadRequestException('Training result conflicts with an already accepted result');
      }
      if (Number(radar.current_definition_version) !== version || radar.status !== 'training') throw new BadRequestException('Stale training result cannot change current Radar');
      if (result.status !== 'succeeded') {
        const state = radar.current_model_reference ? 'active' : result.status === 'insufficient_data' ? 'insufficient_data' : 'failed';
        await tx.execute(sql`update radar_training_requests set status=${result.status},failure_category=${result.status === 'insufficient_data' ? 'insufficient_data' : this.safe(result.failureCategory)},failure_reason=${this.safe(result.failureReason)},model_reference=null,claimed_by=null,lease_expires_at=null,terminal_at=now(),updated_at=now() where workspace_id=${workspaceId} and id=${requestId}`);
        await tx.execute(sql`update radars set status=${state},updated_at=now() where workspace_id=${workspaceId} and id=${radarId}`);
        return;
      }
      const modelId = result.modelReference?.trim(); if (!modelId) throw new BadRequestException('Successful training result requires model reference');
      const [model] = await tx.execute(sql`select * from radar_model_versions where workspace_id=${workspaceId} and id=${modelId} and radar_id=${radarId} and definition_version=${version} and training_request_id=${requestId} for update`);
      if (!model || model.status !== 'training' || !model.verified_at) throw new BadRequestException('Successful training result requires a verified training model');
      const [batch] = await tx.execute(sql`select 1 from radar_score_batches where workspace_id=${workspaceId} and radar_id=${radarId} and model_version_id=${modelId} and status='completed'`);
      if (!batch) throw new BadRequestException('Successful training result requires completed initial scoring');
      await tx.execute(sql`update radar_model_versions set status='validated',validation=jsonb_build_object('validatedAt',now(),'initialScoreBatch','completed','artifactChecksum',artifact_checksum) where workspace_id=${workspaceId} and id=${modelId}`);
      await tx.execute(sql`update radar_training_requests set status='succeeded',model_reference=${modelId},failure_category=null,failure_reason=null,claimed_by=null,lease_expires_at=null,terminal_at=now(),updated_at=now() where workspace_id=${workspaceId} and id=${requestId}`);
      await tx.execute(sql`update radars set status=${radar.current_model_reference ? 'active' : 'ready_to_train'},updated_at=now() where workspace_id=${workspaceId} and id=${radarId}`);
      await this.audit.record({ workspaceId, actorType: 'system', category: 'model_registry', action: 'training_validated', resourceType: 'radar_model', resourceId: modelId, metadata: { radarId, requestId, definitionVersion: version } });
    });
  }

  async promote(workspaceId: string, radarId: string, modelId: string, actorUserId?: string, reason = 'explicit_promotion') { return this.activate(workspaceId, radarId, modelId, actorUserId, 'promoted', reason); }
  async rollback(workspaceId: string, radarId: string, modelId: string, actorUserId?: string, reason = 'explicit_rollback') { return this.activate(workspaceId, radarId, modelId, actorUserId, 'rolled_back', reason, true); }
  async retire(workspaceId: string, radarId: string, modelId: string, actorUserId?: string, reason = 'explicit_retirement') {
    return this.db.transaction(async (tx) => {
      const [model] = await tx.execute(sql`select * from radar_model_versions where workspace_id=${workspaceId} and id=${modelId} and radar_id=${radarId} for update`); if (!model) throw new NotFoundException('Model not found');
      const [radar] = await tx.execute(sql`select * from radars where workspace_id=${workspaceId} and id=${radarId} for update`); if (!radar) throw new NotFoundException('Radar not found');
      await tx.execute(sql`update radar_model_versions set status='retired' where workspace_id=${workspaceId} and id=${modelId}`);
      if (radar.current_model_reference === modelId) await tx.execute(sql`update radars set current_model_reference=null,status='ready_to_train',updated_at=now() where workspace_id=${workspaceId} and id=${radarId}`);
      await this.audit.record({ workspaceId, actorUserId, category: 'model_registry', action: 'retired', resourceType: 'radar_model', resourceId: modelId, metadata: { radarId, reason } });
    });
  }

  async health(workspaceId: string, radarId: string, modelId: string, verifyArtifact = false) {
    const model = await this.model(workspaceId, radarId, modelId); const [radar] = await this.db.execute(sql`select current_definition_version from radars where workspace_id=${workspaceId} and id=${radarId}`);
    if (model.status === 'failed') return { lifecycle: model.status, health: 'failed', reasons: ['training_failed'] };
    if (model.status === 'training') return { lifecycle: model.status, health: 'insufficient', reasons: ['training_incomplete'] };
    if (Number(radar.current_definition_version) !== Number(model.definition_version)) return { lifecycle: model.status, health: 'schema_incompatible', reasons: ['definition_version_mismatch'] };
    if (verifyArtifact) { const check = await this.artifacts.verify(this.artifact(model)); if (!check.ok) return { lifecycle: model.status, health: 'artifact_unavailable', reasons: [check.reason] }; }
    const stale = model.promoted_at && Date.now() - new Date(model.promoted_at).getTime() > 31 * 86400_000;
    return { lifecycle: model.status, health: stale ? 'stale' : 'healthy', reasons: [] };
  }

  async maintainWorkspace(workspaceId: string): Promise<void> {
    const models = await this.db.execute(sql`select id,radar_id,status from radar_model_versions where workspace_id=${workspaceId} and status in ('active','validated')`);
    for (const row of models as unknown as Array<{ id: string; radar_id: string; status: string }>) {
      try {
        const health = await this.health(workspaceId, row.radar_id, row.id, false);
        const [distribution] = await this.db.execute(sql`select count(*)::int count,avg(probability)::float8 mean,stddev_pop(probability)::float8 dispersion,min(probability)::float8 min,max(probability)::float8 max,percentile_cont(0.1) within group(order by probability)::float8 p10,percentile_cont(0.5) within group(order by probability)::float8 p50,percentile_cont(0.9) within group(order by probability)::float8 p90,count(*) filter(where probability::float8 < 0 or probability::float8 > 1)::int invalid from radar_propensity_scores where workspace_id=${workspaceId} and radar_id=${row.radar_id} and model_version_id=${row.id} and scored_at > now()-interval '24 hours'`);
        const [feedback] = await this.db.execute(sql`select count(*)::int scored,count(o.id)::int outcomes from radar_propensity_scores s left join radar_model_versions m on m.workspace_id=s.workspace_id and m.id=s.model_version_id left join customer_outcomes o on o.workspace_id=s.workspace_id and o.customer_id=s.customer_id and o.outcome_definition_id=m.target_outcome_definition_id and o.observed_at>=s.scoring_cutoff and o.observed_at<s.scoring_cutoff+(m.prediction_window_days||' days')::interval where s.workspace_id=${workspaceId} and s.radar_id=${row.radar_id} and s.model_version_id=${row.id} and s.scored_at > now()-interval '90 days'`);
        const d = distribution as Record<string, unknown>; const anomalies = [Number(d.invalid) > 0 ? 'invalid_probability' : '', Number(d.count) === 0 ? 'no_recent_scores' : ''].filter(Boolean);
        await this.db.execute(sql`insert into radar_model_monitoring_snapshots (workspace_id,id,radar_id,model_version_id,snapshot_type,health_status,metrics,anomalies) values (${workspaceId},${`mms_${ulid()}`},${row.radar_id},${row.id},'distribution_feedback',${health.health},${JSON.stringify({ distribution, feedback })}::jsonb,${JSON.stringify(anomalies)}::jsonb)`);
      } catch { /* monitoring is best effort; a bad model must not disable the scheduler */ }
    }
  }

  private async activate(workspaceId: string, radarId: string, modelId: string, actorUserId: string | undefined, action: string, reason: string, allowRetired = false) {
    return this.db.transaction(async (tx) => {
      const [radar] = await tx.execute(sql`select * from radars where workspace_id=${workspaceId} and id=${radarId} for update`); if (!radar) throw new NotFoundException('Radar not found');
      const [model] = await tx.execute(sql`select * from radar_model_versions where workspace_id=${workspaceId} and id=${modelId} and radar_id=${radarId} for update`); if (!model) throw new NotFoundException('Model not found');
      if (!['validated', ...(allowRetired ? ['retired'] : [])].includes(String(model.status))) throw new BadRequestException('Model is not eligible for this lifecycle operation');
      if (Number(model.definition_version) !== Number(radar.current_definition_version)) throw new BadRequestException('Model is incompatible with current Radar definition');
      const artifact = await this.artifacts.verify(this.artifact(model as unknown as Model)); if (!artifact.ok) throw new BadRequestException(`Model artifact is unavailable: ${artifact.reason}`);
      await tx.execute(sql`update radar_model_versions set status='retired' where workspace_id=${workspaceId} and radar_id=${radarId} and model_role='propensity' and status='active' and id<>${modelId}`);
      await tx.execute(sql`update radar_model_versions set status='active',promoted_at=now(),validation=validation || jsonb_build_object('lastLifecycleOperation',${action}::text,'lastLifecycleAt',now()) where workspace_id=${workspaceId} and id=${modelId}`);
      await tx.execute(sql`update radars set status='active',current_model_reference=${modelId},updated_at=now() where workspace_id=${workspaceId} and id=${radarId}`);
      await this.audit.record({ workspaceId, actorUserId, category: 'model_registry', action, resourceType: 'radar_model', resourceId: modelId, metadata: { radarId, reason } });
      return { modelId, status: 'active' };
    });
  }
  private async radar(workspaceId: string, radarId: string) { const [row] = await this.db.execute(sql`select id from radars where workspace_id=${workspaceId} and id=${radarId}`); if (!row) throw new NotFoundException('Radar not found'); return row; }
  private async model(workspaceId: string, radarId: string, modelId: string): Promise<Model> { const [row] = await this.db.execute(sql`select * from radar_model_versions where workspace_id=${workspaceId} and radar_id=${radarId} and id=${modelId}`); if (!row) throw new NotFoundException('Model not found'); return row as unknown as Model; }
  private artifact(model: Model): StoredModelArtifact { return { artifactProvider: model.artifactProvider ?? (model as unknown as { artifact_provider: string }).artifact_provider, artifactBucket: model.artifactBucket ?? (model as unknown as { artifact_bucket: string }).artifact_bucket, artifactObjectKey: model.artifactObjectKey ?? (model as unknown as { artifact_object_key: string }).artifact_object_key, artifactChecksum: model.artifactChecksum ?? (model as unknown as { artifact_checksum: string }).artifact_checksum }; }
  private safe(value?: string) { return value?.replace(/(?:postgres(?:ql)?:\/\/|access_token=)\S+/gi, '[redacted]').slice(0, 500) ?? null; }
}
