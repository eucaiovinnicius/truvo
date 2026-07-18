import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { aiConversations, type AiConversation, type AiConversationMessage } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { ExplorerService } from '../data-explorer/explorer.service';
import { explorerQuerySpecSchema, type ExplorerQuerySpecInput } from '../data-explorer/compiler/spec';
import {
  EVENT_FIELDS,
  TOUCHPOINT_FIELDS,
  MEASURE_METRICS,
  FILTER_OPS,
  GRANULARITIES,
  DATE_PRESETS,
} from '../data-explorer/compiler/catalog';
import { AiLlmService } from './ai-llm.service';
import { QA_MODEL } from './ai.constants';

/** Nº máximo de linhas repassadas à narrativa (mantém o prompt barato e sem PII em massa). */
const MAX_NARRATE_ROWS = 50;

export interface AskResult {
  conversation_id: string;
  answer: string;
  /** ExplorerQuerySpec (M16) usado — NUNCA SQL cru (regra 19). */
  spec: ExplorerQuerySpecInput | null;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  uncertain: boolean;
  status: string; // ok | invalid_question | aborted | error
  reason?: string;
}

/**
 * M17 — Q&A (pergunta-resposta) via TEXT-TO-QUERY do M16.
 *
 * Fluxo (nunca SQL cru — regra 19):
 *   1. Claude (sonnet) converte a pergunta NL num ExplorerQuerySpec (M16);
 *   2. o spec é VALIDADO pelo zod do M16 (allowlist de forma) e COMPILADO/EXECUTADO
 *      pelo ExplorerService (que injeta workspace_id + is_bot=0 + janela — regra 19);
 *   3. Claude narra o resultado citando SOMENTE as linhas retornadas (nunca inventa),
 *      herdando a marca de incerteza (regra 12) do executor do M16.
 *
 * FAIL-CLOSED: sem ANTHROPIC_API_KEY, /ask responde 503 (o Q&A é intrinsecamente LLM).
 */
@Injectable()
export class AiConversationsService {
  private readonly logger = new Logger(AiConversationsService.name);
  private readonly catalogHint = buildCatalogHint();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly llm: AiLlmService,
    private readonly explorer: ExplorerService,
  ) {}

  async ask(
    workspaceId: string,
    userId: string | undefined,
    question: string,
    conversationId: string | undefined,
  ): Promise<AskResult> {
    if (!this.llm.available()) {
      // fail-closed: Q&A depende do LLM.
      throw new ServiceUnavailableException('Q&A de IA indisponível: ANTHROPIC_API_KEY não configurada.');
    }

    // 1) NL → ExplorerQuerySpec (texto JSON) via LLM.
    const raw = await this.llm.completeText({
      model: QA_MODEL,
      system: this.specSystemPrompt(),
      user: `Pergunta do usuário: ${question}\n\nResponda com APENAS o JSON do ExplorerQuerySpec.`,
      maxTokens: 1500,
      effort: 'medium',
    });

    // 2) parse + validação de forma (allowlist do M16). Falha → mensagem, sem SQL.
    const spec = this.parseAndValidateSpec(raw);
    if (!spec) {
      const answer =
        'Não consegui traduzir a pergunta em uma consulta válida do explorador. Tente ser mais específico (métrica, dimensão e período).';
      const convId = await this.appendMessages(workspaceId, userId, conversationId, question, {
        role: 'assistant',
        content: answer,
        at: new Date().toISOString(),
      });
      return { conversation_id: convId, answer, spec: null, columns: [], rows: [], uncertain: false, status: 'invalid_question' };
    }

    // 3) executa via M16 (preview: barato + seguro). O compilador injeta as invariantes.
    let result;
    try {
      result = await this.explorer.executeSpec(workspaceId, userId, spec, 'preview');
    } catch (err) {
      // ex.: campo fora do catálogo (FieldError → 422 no M16). Nunca cai em SQL.
      this.logger.warn(`executeSpec falhou (ws=${workspaceId}): ${errMessage(err)}`);
      const answer = 'A consulta gerada referenciou um campo indisponível no catálogo. Reformule a pergunta.';
      const convId = await this.appendMessages(workspaceId, userId, conversationId, question, {
        role: 'assistant',
        content: answer,
        spec,
        at: new Date().toISOString(),
      });
      return { conversation_id: convId, answer, spec, columns: [], rows: [], uncertain: false, status: 'error', reason: errMessage(err) };
    }

    if (result.status !== 'ok') {
      const answer =
        result.status === 'aborted'
          ? `A consulta excedeu os limites (${result.reason ?? 'limite'}). Restrinja o período ou o segmento.`
          : 'Não foi possível executar a consulta no momento.';
      const convId = await this.appendMessages(workspaceId, userId, conversationId, question, {
        role: 'assistant',
        content: answer,
        spec,
        at: new Date().toISOString(),
      });
      return { conversation_id: convId, answer, spec, columns: result.columns ?? [], rows: [], uncertain: false, status: result.status, reason: result.reason };
    }

    const columns = result.columns ?? [];
    const rows = (result.rows ?? []).slice(0, MAX_NARRATE_ROWS);
    const uncertain = result.uncertainty?.uncertain === true;

    // 4) narrativa fundamentada (cita só as linhas). Herda a marca de incerteza (regra 12).
    let answer: string;
    try {
      answer = await this.llm.completeText({
        model: QA_MODEL,
        system: this.narrateSystemPrompt(uncertain),
        user: this.narrateUserPrompt(question, columns, rows),
        maxTokens: 1200,
        effort: 'medium',
      });
    } catch (err) {
      this.logger.warn(`narrativa falhou (ws=${workspaceId}): ${errMessage(err)}`);
      answer = 'Resultado obtido, mas não foi possível gerar a narrativa no momento. Veja as linhas retornadas.';
    }

    const convId = await this.appendMessages(workspaceId, userId, conversationId, question, {
      role: 'assistant',
      content: answer,
      spec,
      evidence: { columns, rows, uncertainty: result.uncertainty },
      uncertain,
      at: new Date().toISOString(),
    });

    return { conversation_id: convId, answer, spec, columns, rows, uncertain, status: 'ok' };
  }

  async getConversation(workspaceId: string, conversationId: string): Promise<AiConversation | undefined> {
    const rows = await this.db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.workspaceId, workspaceId), eq(aiConversations.id, conversationId)))
      .limit(1);
    return rows[0];
  }

  async listConversations(workspaceId: string): Promise<AiConversation[]> {
    return this.db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.workspaceId, workspaceId))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(100);
  }

  // ─────────────────────────── persistência de conversa ───────────────────────────

  private async appendMessages(
    workspaceId: string,
    userId: string | undefined,
    conversationId: string | undefined,
    question: string,
    assistant: AiConversationMessage,
  ): Promise<string> {
    const userMsg: AiConversationMessage = { role: 'user', content: question, at: new Date().toISOString() };
    const now = new Date();

    if (conversationId) {
      const existing = await this.getConversation(workspaceId, conversationId);
      if (existing) {
        const messages = [...(existing.messages ?? []), userMsg, assistant];
        await this.db
          .update(aiConversations)
          .set({ messages, updatedAt: now })
          .where(and(eq(aiConversations.workspaceId, workspaceId), eq(aiConversations.id, conversationId)));
        return conversationId;
      }
    }

    const id = `cnv_${ulid()}`;
    await this.db.insert(aiConversations).values({
      id,
      workspaceId,
      userId: userId ?? null,
      title: question.slice(0, 120),
      messages: [userMsg, assistant],
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  // ─────────────────────────── prompts ───────────────────────────

  private specSystemPrompt(): string {
    return [
      'Você converte perguntas de analytics em um ExplorerQuerySpec do Truvo (formato JSON). NUNCA gere SQL.',
      'Use SOMENTE o vocabulário abaixo. Se a pergunta pedir algo fora do catálogo, escolha a aproximação mais próxima dentro do catálogo.',
      'Prefira insight_type "breakdown" (agregação por dimensão) ou "trends" (série temporal). Sempre inclua um date_range (preset ou {from,to}).',
      'Responda com APENAS um objeto JSON válido do ExplorerQuerySpec (sem markdown, sem comentários).',
      '',
      this.catalogHint,
    ].join('\n');
  }

  private narrateSystemPrompt(uncertain: boolean): string {
    const base = [
      'Você é um analista do Truvo. Responda à pergunta do usuário em português, citando SOMENTE os números presentes nas linhas de resultado fornecidas.',
      'NUNCA invente valores. Se as linhas não respondem à pergunta, diga isso. Seja conciso e direto.',
    ];
    if (uncertain) {
      base.push(
        'ATENÇÃO: os dados desta janela estão marcados como INCERTOS (gap de reconciliação alto). Use hedge e avise que os números podem não ser confiáveis.',
      );
    }
    return base.join('\n');
  }

  private narrateUserPrompt(question: string, columns: string[], rows: Array<Record<string, unknown>>): string {
    return [
      `Pergunta: ${question}`,
      `Colunas: ${JSON.stringify(columns)}`,
      `Linhas (${rows.length}, já limitadas): ${JSON.stringify(rows)}`,
      'Responda com base APENAS nessas linhas.',
    ].join('\n');
  }

  private parseAndValidateSpec(raw: string): ExplorerQuerySpecInput | null {
    let obj: unknown;
    try {
      obj = extractJson(raw);
    } catch {
      return null;
    }
    const parsed = explorerQuerySpecSchema.safeParse(obj);
    return parsed.success ? (parsed.data as ExplorerQuerySpecInput) : null;
  }
}

// ─────────────────────────── helpers ───────────────────────────

/** Monta a descrição compacta do catálogo do M16 para o prompt de text-to-query. */
function buildCatalogHint(): string {
  const eventFields = Object.keys(EVENT_FIELDS);
  const touchpointFields = Object.keys(TOUCHPOINT_FIELDS);
  return [
    'CATÁLOGO (allowlist do M16):',
    '- insight_type: "trends" | "breakdown" | "funnel" | "retention" | "path".',
    '- source: "events" (default) | "touchpoints".',
    `- measures[].metric: ${MEASURE_METRICS.join(', ')}. (sum/avg/min/max/p50/p90/p95 exigem "property" numérica; "unique" exige "on").`,
    '- measure: { id, metric, event?, property?, on? }. Ex.: { "id":"purchases","metric":"count","event":"purchase" }.',
    `- filters ops: ${FILTER_OPS.join(', ')} (árvore and/or com "conditions").`,
    `- granularity (trends/retention): ${GRANULARITIES.join(', ')}.`,
    `- date_range: { "preset": <um de: ${Object.keys(DATE_PRESETS).join(', ')}> } OU { "from": ISO, "to": ISO }.`,
    `- campos de events: ${eventFields.join(', ')}. Também properties.<chave> (sem PII).`,
    `- campos de touchpoints: ${touchpointFields.join(', ')}.`,
    '- dimensions/group_by: lista de campos do catálogo. limit: inteiro.',
    'NUNCA inclua workspace_id/is_bot (injetados pelo servidor).',
    'Exemplo (receita por canal últimos 30 dias): {"insight_type":"breakdown","source":"touchpoints","measures":[{"id":"rev","metric":"sum","property":"value"}],"dimensions":["channel"],"date_range":{"preset":"last_30_days"},"limit":20}',
  ].join('\n');
}

/** Extrai um objeto JSON de um texto (tolera cercas/prefixos). Lança se não achar. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const candidates = [trimmed];
  if (fence && fence[1]) candidates.push(fence[1].trim());
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // próximo
    }
  }
  throw new Error('sem JSON');
}

function errMessage(err: unknown): string {
  return String((err as Error)?.message ?? err);
}
