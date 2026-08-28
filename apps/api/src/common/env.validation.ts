import { Logger } from '@nestjs/common';
import { readFeatureFlags } from './feature-flags';

/**
 * Validação de ambiente no BOOT (fail-fast). Antes, uma env essencial ausente virava
 * erro obscuro em runtime (na 1ª query/conexão); aqui o processo falha logo no start
 * com a lista do que falta. Só as VERDADEIRAMENTE essenciais são obrigatórias — o
 * resto do produto é fail-closed (Stripe/Ads/Anthropic/email desligam sozinhos), então
 * apenas AVISAMOS quando uma integração notável está sem credencial.
 */
interface EnvRule {
  key: string;
  /** Aviso mostrado quando ausente (só p/ opcionais). */
  note: string;
}

/** Sem estas, a API não funciona. */
const REQUIRED = ['SUPABASE_URL', 'DATABASE_URL', 'CLICKHOUSE_URL', 'KAFKA_BROKERS', 'REDIS_URL'];

/** Opcionais notáveis: ausência não impede o boot, mas desliga um recurso. */
const OPTIONAL: EnvRule[] = [
  { key: 'INTEGRATIONS_ENCRYPTION_KEY', note: 'M4/M9: credenciais por-workspace (webhooks/CAPI) NÃO podem ser cifradas/lidas' },
  { key: 'INTERNAL_API_SECRET', note: 'M8/M9: forward interno consumer→identify/conversões desligado' },
  { key: 'STRIPE_SECRET_KEY', note: 'M11 billing: checkout/portal/webhook respondem 503' },
  { key: 'ANTHROPIC_API_KEY', note: 'M17: /ai/ask e journeys/analyze respondem 503 (evidence pack segue)' },
  { key: 'CORS_ORIGINS', note: 'CORS permissivo (reflete qualquer Origin) — defina a allowlist em produção' },
];

const isSet = (key: string): boolean => (process.env[key] ?? '').trim().length > 0;

export function productionSafetyProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (!(env.CORS_ORIGINS ?? '').trim()) problems.push('CORS_ORIGINS (obrigatória em production)');
  if (env.TRUVO_DEV_AUTH_BYPASS === '1') problems.push('TRUVO_DEV_AUTH_BYPASS não pode ser 1 em production');
  if (!(env.RELEASE_COMMIT ?? '').trim() || env.RELEASE_COMMIT === 'unknown') problems.push('RELEASE_COMMIT exato é obrigatório em production');
  if (!(env.RELEASE_VERSION ?? '').trim() || env.RELEASE_VERSION === 'unknown') problems.push('RELEASE_VERSION exata é obrigatória em production');
  return problems;
}

export function validateEnv(): void {
  const logger = new Logger('EnvValidation');
  const missing: string[] = REQUIRED.filter((k) => !isSet(k));

  // Auth do Supabase precisa de PELO MENOS uma das chaves.
  if (!isSet('SUPABASE_SERVICE_ROLE_KEY') && !isSet('SUPABASE_ANON_KEY')) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_ANON_KEY)');
  }

  if (missing.length > 0) {
    logger.error(
      `Env obrigatória(s) ausente(s): ${missing.join(', ')}. Configure-as (ver .env.example) antes de subir a API.`,
    );
    // Fail-fast: melhor não subir do que subir quebrado.
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    missing.push(...productionSafetyProblems());
  }

  if (missing.length > 0) {
    logger.error(
      `Configuração de ambiente insegura: ${missing.join(', ')}. Consulte .env.example e docs/operations/environments-and-release.md.`,
    );
    process.exit(1);
  }

  // Flags são opt-in e fail-closed. JSON inválido não pode resultar em um deploy
  // parcialmente habilitado, por isso impede o boot antes de tocar em dependências.
  try {
    readFeatureFlags();
  } catch (error) {
    logger.error(`TRUVO_FEATURE_FLAGS inválida: ${error instanceof Error ? error.message : 'formato inválido'}`);
    process.exit(1);
  }

  for (const rule of OPTIONAL) {
    if (!isSet(rule.key)) logger.warn(`${rule.key} vazia — ${rule.note}.`);
  }
  logger.log('validação de env: essenciais presentes ✓');
}
