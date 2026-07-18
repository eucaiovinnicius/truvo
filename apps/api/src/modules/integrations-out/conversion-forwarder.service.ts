import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  integrationOutLogs,
  type IntegrationOutConfig,
  type IntegrationOutLogStatus,
  type IntegrationOutPlatform,
  type MatchKeyFlags,
} from '@truvo/db';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  CONVERSION_CLIENTS,
  INTEGRATIONS_OUT_DB,
  resolveCanonical,
  type CanonicalConversion,
} from './integrations-out.constants';
import { IntegrationOutConfigService } from './config.service';
import type { Database } from './integrations-out.providers';
import type { ConversionClientRegistry } from './clients';
import type { NormalizedConversion, PlatformSendResult } from './clients/types';
import {
  hasAnyMatchKey,
  normalizeEmailHash,
  normalizePhoneHash,
  scoreMatchKeys,
  type NormalizedMatchKeys,
} from './match-keys';

/**
 * Consentimento capturado no evento (regra 13). Sem `granted === true` NENHUMA PII
 * é enviada a terceiros. Os flags granulares mapeiam para Consent Mode (Google) /
 * data_processing_options (Meta) numa evolução futura.
 */
export interface ConversionConsent {
  granted: boolean;
  adUserData?: boolean;
  adPersonalization?: boolean;
}

/** Match keys CRUAS (claro ou hash) vindas do evento de conversão. */
export interface RawMatchKeys {
  email?: string;
  phone?: string;
  clickId?: string; // Truvo `click_id` genérico
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  fbp?: string;
  externalId?: string;
  ip?: string; // NUNCA persistido (regra 5)
  userAgent?: string;
}

/**
 * Entrada do forwarder — construída pelo consumer/M8 a partir de um TruvoEvent de
 * conversão (purchase/lead/…) ENQUANTO a PII viva ainda está disponível.
 */
export interface ConversionForwardInput {
  workspaceId: string;
  eventId: string;
  eventName: string;
  timestampMs?: number;
  value?: number;
  currency?: string;
  sourceUrl?: string;
  orderId?: string;
  consent: ConversionConsent;
  matchKeys: RawMatchKeys;
  /** Restringe a plataformas específicas (default: todas as habilitadas). */
  platforms?: IntegrationOutPlatform[];
}

export interface PlatformForwardResult {
  platform: IntegrationOutPlatform;
  status: IntegrationOutLogStatus;
  platformEvent?: string;
  matchQuality?: number;
  matchKeysCount?: number;
  httpStatus?: number;
  error?: string;
}

export interface ForwardSummary {
  eventId: string;
  results: PlatformForwardResult[];
}

/**
 * M9 — CONVERSION FORWARDER (coração do módulo). Recebe uma conversão e a envia,
 * server-side, para as plataformas habilitadas do workspace, respeitando:
 *  · regra 13 — consentimento/base legal (fail-closed): sem consentimento, não envia;
 *  · dedup por `event_id` — não reenvia o que já foi 'sent' (pixel+CAPI 1x só);
 *  · regra 4/5/7 — hashes viajam, IP nunca persiste, segredos ficam cifrados.
 *
 * Cada tentativa vira uma linha em `integration_out_logs` (auditoria + monitor de
 * Event Match Quality). Nunca lança para o chamador: uma plataforma que falha não
 * derruba as outras.
 *
 * // TODO(live): WIRING. O consumer (apps/consumer) é um processo standalone (não
 * // Nest). Na onda de integração, o passo de conversão do consumer publica num
 * // tópico Kafka `truvo.conversions.out` que um worker da API consome e chama
 * // `forward(...)`; OU o forwarder é extraído para um pacote compartilhado. Aqui
 * // expomos o serviço pronto (exports do módulo) — ver openTODOs/notes.
 */
@Injectable()
export class ConversionForwarderService {
  private readonly logger = new Logger(ConversionForwarderService.name);

  constructor(
    @Inject(INTEGRATIONS_OUT_DB) private readonly db: Database,
    @Inject(CONVERSION_CLIENTS) private readonly clients: ConversionClientRegistry,
    private readonly configs: IntegrationOutConfigService,
  ) {}

  /** Normaliza as match keys cruas uma única vez. */
  private normalize(raw: RawMatchKeys): NormalizedMatchKeys {
    return {
      emailHash: normalizeEmailHash(raw.email),
      phoneHash: normalizePhoneHash(raw.phone),
      clickId: raw.clickId || undefined,
      fbclid: raw.fbclid || undefined,
      gclid: raw.gclid || undefined,
      ttclid: raw.ttclid || undefined,
      fbp: raw.fbp || undefined,
      externalId: raw.externalId || undefined,
      ip: raw.ip || undefined,
      userAgent: raw.userAgent || undefined,
    };
  }

  /** Click id relevante para a plataforma (Meta=fbclid, Google=gclid, TikTok=ttclid). */
  private relevantClickId(
    platform: IntegrationOutPlatform,
    mk: NormalizedMatchKeys,
  ): string | undefined {
    if (platform === 'meta_capi') return mk.fbclid ?? mk.clickId;
    if (platform === 'google_enhanced') return mk.gclid ?? mk.clickId;
    return mk.ttclid ?? mk.clickId;
  }

  /**
   * Encaminha uma conversão para todas as plataformas habilitadas (ou as filtradas
   * em `input.platforms`). Idempotente por (workspace, platform, event_id).
   */
  async forward(input: ConversionForwardInput): Promise<ForwardSummary> {
    const results: PlatformForwardResult[] = [];
    const eventTimeMs = input.timestampMs ?? Date.now();

    let enabled = await this.configs.listEnabled(input.workspaceId);
    if (input.platforms?.length) {
      const wanted = new Set(input.platforms);
      enabled = enabled.filter((c) => wanted.has(c.platform));
    }
    if (enabled.length === 0) {
      return { eventId: input.eventId, results };
    }

    const mk = this.normalize(input.matchKeys);

    for (const cfg of enabled) {
      try {
        const r = await this.forwardOne(input, cfg, mk, eventTimeMs);
        results.push(r);
      } catch (e) {
        // Salvaguarda: forwardOne já encapsula erros; isto cobre falha de log/decrypt.
        this.logger.warn(
          `forward falhou p/ ${cfg.platform} (event_id=${input.eventId}): ${(e as Error).message}`,
        );
        results.push({
          platform: cfg.platform,
          status: 'failed',
          error: (e as Error).message,
        });
      }
    }
    return { eventId: input.eventId, results };
  }

  private async forwardOne(
    input: ConversionForwardInput,
    cfg: IntegrationOutConfig,
    mk: NormalizedMatchKeys,
    eventTimeMs: number,
  ): Promise<PlatformForwardResult> {
    const platform = cfg.platform;
    const client = this.clients.get(platform);
    if (!client) {
      return this.record(input, platform, 'skipped_disabled', {
        error: 'client não registrado',
      });
    }

    // regra 13 — base legal / consentimento (fail-closed).
    if (cfg.consentRequired && !input.consent.granted) {
      return this.record(input, platform, 'skipped_no_consent', {});
    }

    // Mapeia o evento Truvo → conversão canônica (com override do workspace).
    const canonical = resolveCanonical(input.eventName, cfg.config.event_map);
    if (!canonical) {
      return this.record(input, platform, 'skipped_unmapped', {});
    }
    const platformEvent = client.platformEventName(canonical);
    if (!platformEvent) {
      return this.record(input, platform, 'skipped_unmapped', { canonical });
    }

    // Precisa de ao menos uma match key utilizável (senão o envio é inútil).
    const relevantClickId = this.relevantClickId(platform, mk);
    if (!hasAnyMatchKey(mk, relevantClickId)) {
      return this.record(input, platform, 'skipped_no_match_keys', { canonical, platformEvent });
    }

    // Dedup server-side: já enviamos com sucesso este event_id p/ esta plataforma?
    if (await this.alreadySent(input.workspaceId, platform, input.eventId)) {
      return this.record(input, platform, 'skipped_duplicate', { canonical, platformEvent });
    }

    const quality = scoreMatchKeys(mk, relevantClickId);
    const conversion: NormalizedConversion = {
      eventId: input.eventId,
      eventName: input.eventName,
      canonical,
      eventTimeMs,
      value: input.value,
      currency: input.currency,
      sourceUrl: input.sourceUrl,
      orderId: input.orderId,
      matchKeys: mk,
    };

    let creds;
    try {
      creds = this.configs.decryptCredentials(cfg);
    } catch (e) {
      const err = `credenciais ilegíveis: ${(e as Error).message}`;
      await this.configs.markResult(input.workspaceId, platform, false, err);
      return this.record(input, platform, 'failed', {
        canonical,
        platformEvent,
        quality,
        error: err,
      });
    }

    const res: PlatformSendResult = await client.send(creds, cfg.config, conversion, {
      test: false,
    });

    await this.configs.markResult(input.workspaceId, platform, res.ok, res.error);
    return this.record(input, platform, res.ok ? 'sent' : 'failed', {
      canonical,
      platformEvent,
      quality,
      httpStatus: res.httpStatus,
      error: res.error,
      response: res.response,
    });
  }

  /** Existe log 'sent' para (workspace, platform, event_id)? (dedup idempotente). */
  private async alreadySent(
    workspaceId: string,
    platform: IntegrationOutPlatform,
    eventId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: integrationOutLogs.id })
      .from(integrationOutLogs)
      .where(
        and(
          eq(integrationOutLogs.workspaceId, workspaceId),
          eq(integrationOutLogs.platform, platform),
          eq(integrationOutLogs.eventId, eventId),
          eq(integrationOutLogs.status, 'sent'),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Insere uma linha de auditoria (SEM PII) e devolve o resultado estruturado. */
  private async record(
    input: ConversionForwardInput,
    platform: IntegrationOutPlatform,
    status: IntegrationOutLogStatus,
    extra: {
      canonical?: CanonicalConversion;
      platformEvent?: string;
      quality?: { score: number; count: number; flags: MatchKeyFlags };
      httpStatus?: number;
      error?: string;
      response?: Record<string, unknown>;
    },
  ): Promise<PlatformForwardResult> {
    const quality = extra.quality;
    try {
      await this.db.insert(integrationOutLogs).values({
        id: `iol_${ulid()}`,
        workspaceId: input.workspaceId,
        platform,
        eventId: input.eventId,
        eventName: input.eventName,
        platformEvent: extra.platformEvent ?? null,
        status,
        httpStatus: extra.httpStatus ?? null,
        matchQuality: quality?.score ?? null,
        matchKeysCount: quality?.count ?? 0,
        matchKeys: quality?.flags ?? {},
        value: input.value ?? null,
        currency: input.currency ?? null,
        error: extra.error ?? null,
        response: extra.response ?? null,
      });
    } catch (e) {
      this.logger.warn(`falha ao logar envio ${platform}/${status}: ${(e as Error).message}`);
    }
    return {
      platform,
      status,
      platformEvent: extra.platformEvent,
      matchQuality: quality?.score,
      matchKeysCount: quality?.count,
      httpStatus: extra.httpStatus,
      error: extra.error,
    };
  }

  // ───────────────────────────── teste manual (POST) ─────────────────────────────

  /**
   * Testa uma plataforma: valida credenciais (ping) e, se `sample` trouxer match
   * keys, envia UMA conversão de teste (test:true → usa `test_event_code`, não conta
   * no Events Manager). Ação administrativa manual — consentimento é do próprio dono
   * da conta. Atualiza o status da config com o resultado.
   */
  async test(
    workspaceId: string,
    platform: IntegrationOutPlatform,
    sample: {
      eventName: string;
      value?: number;
      currency?: string;
      email?: string;
      phone?: string;
      clickId?: string;
      externalId?: string;
    },
  ): Promise<{
    ok: boolean;
    message: string;
    checks: Record<string, boolean>;
    sent?: PlatformSendResult;
    canonical?: CanonicalConversion;
    platformEvent?: string;
    matchQuality?: number;
  }> {
    const cfg = await this.configs.findRaw(workspaceId, platform);
    if (!cfg) {
      return { ok: false, message: 'plataforma não configurada', checks: {} };
    }
    const client = this.clients.get(platform);
    if (!client) {
      return { ok: false, message: 'client não registrado', checks: {} };
    }

    let creds;
    try {
      creds = this.configs.decryptCredentials(cfg);
    } catch (e) {
      return {
        ok: false,
        message: `credenciais ilegíveis: ${(e as Error).message}`,
        checks: { credentials_decrypt: false },
      };
    }

    const ping = await client.ping(creds, cfg.config);
    const checks = { credentials_decrypt: true, ...ping.checks };

    // Tenta um envio de teste quando há match keys + evento mapeável.
    const mk = this.normalize({
      email: sample.email,
      phone: sample.phone,
      clickId: sample.clickId,
      fbclid: sample.clickId,
      gclid: sample.clickId,
      ttclid: sample.clickId,
      externalId: sample.externalId,
    });
    const canonical = resolveCanonical(sample.eventName, cfg.config.event_map);
    const platformEvent = canonical ? client.platformEventName(canonical) : undefined;
    const relevantClickId = this.relevantClickId(platform, mk);
    const canSend =
      ping.ok && canonical && platformEvent && hasAnyMatchKey(mk, relevantClickId);

    let sent: PlatformSendResult | undefined;
    let matchQuality: number | undefined;
    if (canSend && canonical && platformEvent) {
      const quality = scoreMatchKeys(mk, relevantClickId);
      matchQuality = quality.score;
      const conversion: NormalizedConversion = {
        eventId: `test_${ulid()}`,
        eventName: sample.eventName,
        canonical,
        eventTimeMs: Date.now(),
        value: sample.value,
        currency: sample.currency,
        matchKeys: mk,
      };
      sent = await client.send(creds, cfg.config, conversion, { test: true });
    }

    const ok = sent ? sent.ok : ping.ok;
    await this.configs.markResult(workspaceId, platform, ok, sent?.error ?? (ok ? undefined : ping.message));
    return {
      ok,
      message: sent
        ? sent.ok
          ? 'envio de teste aceito pela plataforma'
          : `envio de teste rejeitado: ${sent.error ?? 'erro'}`
        : ping.message,
      checks,
      sent,
      canonical,
      platformEvent,
      matchQuality,
    };
  }

  // ─────────────────── leitura para controller (status/monitor) ───────────────────

  /**
   * Estatísticas de envio + EMQ médio (dos 'sent') numa janela recente. Base do
   * monitor de Event Match Quality (PRD §7 M9).
   */
  async stats(
    workspaceId: string,
    platform: IntegrationOutPlatform,
    sinceDays = 7,
  ): Promise<{
    sent: number;
    failed: number;
    skipped: number;
    avgMatchQuality: number | null;
    byStatus: Record<string, number>;
  }> {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const rows = await this.db
      .select({
        status: integrationOutLogs.status,
        n: sql<number>`count(*)::int`,
        avgEmq: sql<number | null>`avg(${integrationOutLogs.matchQuality})`,
      })
      .from(integrationOutLogs)
      .where(
        and(
          eq(integrationOutLogs.workspaceId, workspaceId),
          eq(integrationOutLogs.platform, platform),
          gte(integrationOutLogs.createdAt, since),
        ),
      )
      .groupBy(integrationOutLogs.status);

    const byStatus: Record<string, number> = {};
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let avgMatchQuality: number | null = null;
    for (const r of rows) {
      const n = Number(r.n) || 0;
      byStatus[r.status] = n;
      if (r.status === 'sent') {
        sent += n;
        avgMatchQuality = r.avgEmq != null ? Math.round(Number(r.avgEmq) * 10) / 10 : avgMatchQuality;
      } else if (r.status === 'failed') {
        failed += n;
      } else {
        skipped += n;
      }
    }
    return { sent, failed, skipped, avgMatchQuality, byStatus };
  }

  /** Logs recentes (monitor de EMQ), escopados por workspace + plataforma. */
  async recentLogs(
    workspaceId: string,
    platform: IntegrationOutPlatform,
    filter: { status?: IntegrationOutLogStatus; limit: number; offset: number },
  ) {
    const conds = [
      eq(integrationOutLogs.workspaceId, workspaceId),
      eq(integrationOutLogs.platform, platform),
    ];
    if (filter.status) conds.push(eq(integrationOutLogs.status, filter.status));
    return this.db
      .select({
        id: integrationOutLogs.id,
        eventId: integrationOutLogs.eventId,
        eventName: integrationOutLogs.eventName,
        platformEvent: integrationOutLogs.platformEvent,
        status: integrationOutLogs.status,
        httpStatus: integrationOutLogs.httpStatus,
        matchQuality: integrationOutLogs.matchQuality,
        matchKeysCount: integrationOutLogs.matchKeysCount,
        matchKeys: integrationOutLogs.matchKeys,
        value: integrationOutLogs.value,
        currency: integrationOutLogs.currency,
        error: integrationOutLogs.error,
        response: integrationOutLogs.response,
        createdAt: integrationOutLogs.createdAt,
      })
      .from(integrationOutLogs)
      .where(and(...conds))
      .orderBy(desc(integrationOutLogs.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }
}
