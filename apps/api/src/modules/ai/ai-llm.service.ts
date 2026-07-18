import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY_ENV } from './ai.constants';

/**
 * M17 — Fase 2 (LLM). Wrapper fino sobre o @anthropic-ai/sdk.
 *
 * FAIL-CLOSED (regra): sem ANTHROPIC_API_KEY no env, o client não é construído e
 * `available()` = false. Os métodos lançam 503 — nunca inventamos números nem
 * respostas. A Fase 1 (evidence pack determinístico) NÃO depende disto.
 *
 * PRIVACIDADE (regra 4/5): quem chama SÓ passa agregados + rótulos de canal no
 * `user`/`system`. Este wrapper não conhece PII e não a busca.
 *
 * O client lê a chave do env em runtime (não em build). // TODO(live): a chave
 * Anthropic precisa estar em ANTHROPIC_API_KEY (ver .env / secret manager).
 */
export interface LlmJsonRequest {
  model: string;
  system: string;
  user: string;
  /** JSON Schema da saída estruturada (output_config.format). */
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Habilita adaptive thinking (default true — opus/sonnet atuais). */
  thinking?: boolean;
}

export interface LlmTextRequest {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  thinking?: boolean;
}

@Injectable()
export class AiLlmService {
  private readonly logger = new Logger(AiLlmService.name);
  private readonly client: Anthropic | null;

  constructor() {
    const apiKey = process.env[ANTHROPIC_API_KEY_ENV];
    if (apiKey && apiKey.trim().length > 0) {
      this.client = new Anthropic({ apiKey });
    } else {
      this.client = null;
      this.logger.warn(
        `${ANTHROPIC_API_KEY_ENV} ausente — recursos de IA (análise/Q&A) indisponíveis (fail-closed).`,
      );
    }
  }

  /** A Fase 2 (LLM) está disponível? */
  available(): boolean {
    return this.client !== null;
  }

  private requireClient(): Anthropic {
    if (!this.client) {
      throw new ServiceUnavailableException(
        `IA indisponível: ${ANTHROPIC_API_KEY_ENV} não configurada (fail-closed).`,
      );
    }
    return this.client;
  }

  /**
   * Completa com SAÍDA ESTRUTURADA (output_config.format = json_schema) e devolve o
   * objeto já parseado/validado pelo modelo. Usado na análise de jornadas (Fase 2):
   * o modelo só pode citar o evidence (o schema restringe a forma).
   */
  async completeJson<T>(req: LlmJsonRequest): Promise<T> {
    const client = this.requireClient();
    const res = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 8000,
      system: req.system,
      thinking: req.thinking === false ? { type: 'disabled' } : { type: 'adaptive' },
      output_config: {
        effort: req.effort ?? 'high',
        format: { type: 'json_schema', schema: req.schema },
      },
      messages: [{ role: 'user', content: req.user }],
    });

    this.assertNotRefused(res);
    const text = extractText(res);
    return parseJsonObject<T>(text);
  }

  /**
   * Completa com TEXTO livre (ou JSON que o chamador parseia). Usado no text-to-query
   * (gerar ExplorerQuerySpec do M16 — union recursiva, incompatível com json_schema)
   * e na narrativa fundamentada do Q&A.
   */
  async completeText(req: LlmTextRequest): Promise<string> {
    const client = this.requireClient();
    const res = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      thinking: req.thinking === false ? { type: 'disabled' } : { type: 'adaptive' },
      output_config: { effort: req.effort ?? 'medium' },
      messages: [{ role: 'user', content: req.user }],
    });

    this.assertNotRefused(res);
    return extractText(res);
  }

  private assertNotRefused(res: Anthropic.Message): void {
    if (res.stop_reason === 'refusal') {
      this.logger.warn(`Claude recusou a requisição (stop_reason=refusal).`);
      throw new ServiceUnavailableException('O modelo recusou a análise para esta requisição.');
    }
  }
}

/** Concatena os blocos de texto da resposta. */
function extractText(res: Anthropic.Message): string {
  let out = '';
  for (const block of res.content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

/**
 * Parseia um objeto JSON de um texto, tolerando cercas ```json ... ``` e prefixos.
 * Lança se não encontrar um objeto válido — nunca "chuta" (fail-closed).
 */
export function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  const candidates: string[] = [];
  // 1) tenta o texto inteiro
  candidates.push(trimmed);
  // 2) conteúdo de uma cerca de código
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  // 3) do 1º '{' ao último '}'
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // tenta o próximo candidato
    }
  }
  throw new ServiceUnavailableException('Resposta do modelo não é um JSON válido.');
}
