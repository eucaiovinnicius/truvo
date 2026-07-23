import { Logger } from '@nestjs/common';

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

  for (const rule of OPTIONAL) {
    if (!isSet(rule.key)) logger.warn(`${rule.key} vazia — ${rule.note}.`);
  }
  logger.log('validação de env: essenciais presentes ✓');
}
