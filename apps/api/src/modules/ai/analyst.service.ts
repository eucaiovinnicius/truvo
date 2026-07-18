import { Injectable } from '@nestjs/common';
import type { AiEvidencePack } from '@truvo/db';
import { AiLlmService } from './ai-llm.service';
import { AI_INSIGHT_SEVERITIES, ANALYSIS_MODEL, type AiGoal } from './ai.constants';

/** Saída estruturada da Fase 2 (o schema abaixo a restringe). */
export interface AnalystRanking {
  channel: string;
  rank: number;
  reason: string;
}
export interface AnalystInsight {
  severity: string;
  title: string;
  body: string;
  metric?: string;
  channel?: string;
  evidence_ref: string;
}
export interface AnalystRecommendation {
  title: string;
  rationale: string;
  action: string;
  expected_impact?: string;
  channel?: string;
  priority?: number;
  evidence_ref: string;
}
export interface AnalystOutput {
  summary: string;
  ranking: AnalystRanking[];
  insights: AnalystInsight[];
  recommendations: AnalystRecommendation[];
}

/** JSON Schema da saída estruturada (sem constraints numéricas/string — regra do SDK). */
const ANALYST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          channel: { type: 'string' },
          rank: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['channel', 'rank', 'reason'],
      },
    },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: [...AI_INSIGHT_SEVERITIES] },
          title: { type: 'string' },
          body: { type: 'string' },
          metric: { type: 'string' },
          channel: { type: 'string' },
          evidence_ref: { type: 'string' },
        },
        required: ['severity', 'title', 'body', 'evidence_ref'],
      },
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          rationale: { type: 'string' },
          action: { type: 'string' },
          expected_impact: { type: 'string' },
          channel: { type: 'string' },
          priority: { type: 'integer' },
          evidence_ref: { type: 'string' },
        },
        required: ['title', 'rationale', 'action', 'evidence_ref'],
      },
    },
  },
  required: ['summary', 'ranking', 'insights', 'recommendations'],
};

const GOAL_HINT: Record<AiGoal, string> = {
  maximize_roas: 'Maximizar ROAS (receita atribuída / spend). Priorize canais com maior ROAS confiável.',
  minimize_cac: 'Minimizar CAC (spend / conversões). Priorize canais com menor CAC confiável.',
  maximize_ltv: 'Maximizar LTV. Use ltv_proxy como sinal (é um proxy de janela — trate como aproximação).',
  maximize_cvr: 'Maximizar CVR. Use cvr_wilson_lower (não o cvr pontual) para não superestimar canais de baixa amostra.',
  maximize_revenue: 'Maximizar receita. Priorize canais com maior receita atribuída, ponderando a confiabilidade da reconciliação.',
};

/**
 * M17 — Fase 2 (LLM). Recebe o evidence pack (SÓ agregados + rótulos de canal) e
 * produz ranking + narrativa + insights + recomendações. Regras inegociáveis no
 * prompt:
 *  · NUNCA inventar número — só citar valores presentes no evidence pack (evidence_ref);
 *  · se `uncertain` = true (gap de reconciliação alto) → modo incerteza: hedge,
 *    baixa confiança, evitar afirmações fortes sobre receita;
 *  · sem PII (o pack não tem PII — só canais/agregados);
 *  · 1 workspace por vez (o pack já é escopado).
 */
@Injectable()
export class AiAnalystService {
  constructor(private readonly llm: AiLlmService) {}

  available(): boolean {
    return this.llm.available();
  }

  async analyze(pack: AiEvidencePack): Promise<AnalystOutput> {
    const system = this.buildSystemPrompt(pack.goal, pack.uncertain);
    const user = this.buildUserPrompt(pack);
    return this.llm.completeJson<AnalystOutput>({
      model: ANALYSIS_MODEL,
      system,
      user,
      schema: ANALYST_SCHEMA,
      maxTokens: 8000,
      effort: 'high',
      thinking: true,
    });
  }

  private buildSystemPrompt(goal: AiGoal, uncertain: boolean): string {
    const lines = [
      'Você é um analista de marketing/atribuição do Truvo. Você recebe APENAS um "evidence pack" com agregados já calculados de forma determinística (nunca dados crus, nunca PII).',
      'REGRAS INEGOCIÁVEIS:',
      '1. NUNCA invente números. Cite SOMENTE valores presentes no evidence pack. Cada insight e recomendação DEVE ter um evidence_ref apontando para uma chave do pack (ex.: "channels.paid_social", "reconciliation", "top_journeys", "anomalies").',
      '2. Se um valor for null (ex.: spend/roas/cac quando spend_available=false), NÃO o infira — diga explicitamente que está indisponível.',
      '3. Para CVR, use cvr_wilson_lower (limite inferior), não o cvr pontual, ao comparar canais — evita superestimar baixa amostra.',
      `4. OBJETIVO desta análise: ${GOAL_HINT[goal]}`,
      '5. Responda estritamente no schema JSON solicitado, em português. Seja específico e acionável, mas conciso.',
    ];
    if (uncertain) {
      lines.push(
        '6. MODO INCERTEZA: o gap de reconciliação está acima do limiar (reconciliation.status = "uncertain"). Os números de RECEITA podem não ser confiáveis. Baixe a confiança, use hedge ("possivelmente", "sujeito a reconciliação") e evite recomendações agressivas baseadas em receita. Inclua um insight de severidade "critical" sobre a incerteza.',
      );
    }
    return lines.join('\n');
  }

  private buildUserPrompt(pack: AiEvidencePack): string {
    return [
      'Analise o evidence pack abaixo e produza: (a) um summary curto; (b) ranking dos canais para o objetivo; (c) insights (incl. anomalias já detectadas em anomalies); (d) recomendações acionáveis. Cada item cita evidence_ref.',
      '',
      'EVIDENCE PACK (JSON):',
      JSON.stringify(pack),
    ].join('\n');
  }
}
