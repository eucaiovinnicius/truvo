import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { KafkaProducerService } from '../webhooks/kafka-producer.service';

export const PROPENSITY_TRAINING_TOPIC = process.env.PROPENSITY_TRAINING_TOPIC ?? 'truvo.propensity.training';
export const PROPENSITY_SCORING_TOPIC = process.env.PROPENSITY_SCORING_TOPIC ?? 'truvo.propensity.scoring';

export interface PropensityDispatch {
  workspaceId: string;
  radarId: string;
  definitionVersion: number;
  trainingRequestId: string;
  correlationId: string;
}

type RequestRow = {
  workspace_id: string; radar_id: string; definition_version: number; id: string; correlation_id: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class PropensityDispatchService {
  private readonly logger = new Logger(PropensityDispatchService.name);
  private readonly retrainIntervalDays = positiveInteger(process.env.PROPENSITY_RETRAIN_INTERVAL_DAYS, 30);
  private readonly retryCooldownHours = positiveInteger(process.env.PROPENSITY_RETRAIN_RETRY_COOLDOWN_HOURS, 24);
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly kafka: KafkaProducerService) {}

  private payload(row: RequestRow): PropensityDispatch {
    return { workspaceId: row.workspace_id, radarId: row.radar_id, definitionVersion: row.definition_version, trainingRequestId: row.id, correlationId: row.correlation_id };
  }

  async dispatchTraining(row: RequestRow): Promise<void> {
    const payload = this.payload(row);
    await this.kafka.publish(PROPENSITY_TRAINING_TOPIC, `${payload.workspaceId}:${payload.trainingRequestId}`, payload);
    await this.db.execute(sql`update radar_training_requests set last_dispatched_at=now(),updated_at=now() where workspace_id=${payload.workspaceId} and id=${payload.trainingRequestId}`);
  }

  private async createDueRetrainingRequests(workspaceId: string): Promise<RequestRow[]> {
    const created: RequestRow[] = [];
    for (let index = 0; index < 25; index += 1) {
      const request = await this.db.transaction(async (tx) => {
        const [due] = await tx.execute(sql`
          select r.id as radar_id,r.current_definition_version as definition_version
          from radars r
          join radar_model_versions m on m.workspace_id=r.workspace_id and m.id=r.current_model_reference and m.status='active'
          where r.workspace_id=${workspaceId} and r.status='active'
            and coalesce(m.promoted_at,m.verified_at) <= now()-(${this.retrainIntervalDays} * interval '1 day')
            and not exists (
              select 1 from radar_training_requests active_request
              where active_request.workspace_id=r.workspace_id and active_request.radar_id=r.id
                and active_request.definition_version=r.current_definition_version
                and active_request.status in ('accepted','running')
            )
            and not exists (
              select 1 from radar_training_requests recent_request
              where recent_request.workspace_id=r.workspace_id and recent_request.radar_id=r.id
                and recent_request.definition_version=r.current_definition_version
                and recent_request.created_at > now()-(${this.retryCooldownHours} * interval '1 hour')
            )
          order by coalesce(m.promoted_at,m.verified_at),r.id
          for update of r skip locked limit 1`);
        if (!due) return null;
        const row = due as { radar_id: string; definition_version: number };
        const id = `rtr_${randomUUID()}`;
        const correlationId = randomUUID();
        const [inserted] = await tx.execute(sql`
          insert into radar_training_requests
            (workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id)
          values (${workspaceId},${id},${row.radar_id},${row.definition_version},${`scheduled:${id}`},'accepted',${correlationId})
          returning workspace_id,radar_id,definition_version,id,correlation_id`);
        await tx.execute(sql`update radars set status='training',updated_at=now() where workspace_id=${workspaceId} and id=${row.radar_id} and status='active'`);
        return inserted as unknown as RequestRow;
      });
      if (!request) break;
      created.push(request);
    }
    return created;
  }

  async sweepWorkspace(workspaceId: string): Promise<{ training: number; scoring: number }> {
    const scheduled = await this.createDueRetrainingRequests(workspaceId);
    for (const row of scheduled) await this.dispatchTraining(row);

    const requests = await this.db.execute(sql`
      select tr.workspace_id,tr.radar_id,tr.definition_version,tr.id,tr.correlation_id
      from radar_training_requests tr join radars r on r.workspace_id=tr.workspace_id and r.id=tr.radar_id
      where tr.workspace_id=${workspaceId} and r.current_definition_version=tr.definition_version
        and r.status='training'
        and (tr.status='accepted' or (tr.status='running' and tr.lease_expires_at<=now()))
        and (tr.last_dispatched_at is null or tr.last_dispatched_at<now()-interval '5 minutes')
      order by tr.created_at limit 100`);
    for (const raw of requests as unknown as RequestRow[]) {
      await this.dispatchTraining(raw);
    }

    const dueScores = await this.db.execute(sql`
      select tr.workspace_id,tr.radar_id,tr.definition_version,tr.id,tr.correlation_id
      from radars r
      join radar_model_versions m on m.workspace_id=r.workspace_id and m.id=r.current_model_reference and m.status='active'
      join radar_training_requests tr on tr.workspace_id=m.workspace_id and tr.id=m.training_request_id
      where r.workspace_id=${workspaceId} and r.status='active'
        and not exists (
          select 1 from radar_score_batches b where b.workspace_id=r.workspace_id and b.radar_id=r.id
            and b.model_version_id=m.id and b.scoring_cutoff>=date_trunc('day',now()) and b.status='completed'
        )
      order by r.id limit 100`);
    for (const raw of dueScores as unknown as RequestRow[]) {
      const payload = this.payload(raw);
      await this.kafka.publish(PROPENSITY_SCORING_TOPIC, `${payload.workspaceId}:${payload.radarId}:${payload.definitionVersion}`, payload);
    }
    const training = scheduled.length + requests.length;
    if (training || dueScores.length) this.logger.log(`propensity dispatch workspace=${workspaceId} training=${training} scoring=${dueScores.length}`);
    return { training, scoring: dueScores.length };
  }
}
