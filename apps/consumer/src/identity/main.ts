import 'dotenv/config';
import { StitchWorker } from './stitch-worker';
import { getRedis } from '../redis';

/**
 * Worker dedicado do M8 — STITCHING RETROATIVO.
 * Redis stream (identity.stitch) → recompute idempotente (touchpoints/ClickHouse).
 *
 * Roda como PROCESSO SEPARADO do consumer de eventos (M2): o stitching retroativo é
 * pesado e deve ter sua própria fila/escala (PRD §15). Entrypoint independente.
 *
 * // TODO(live): adicionar um script em apps/consumer/package.json, ex.:
 *   "start:identity-worker": "node dist/identity/main.js"
 *   "dev:identity-worker":   "tsx watch src/identity/main.ts"
 * (não editável por este módulo — contrato de arquivos; ver openTODOs.)
 */
async function main() {
  const worker = new StitchWorker();

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[truvo/consumer] identity worker: ${signal} recebido — encerrando...`);
    await worker.stop();
    await getRedis().quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await worker.start();
  } catch (err) {
    // TODO(live): Redis + ClickHouse no ar (docker-compose).
    // eslint-disable-next-line no-console
    console.error(`[truvo/consumer] identity worker falhou ao iniciar: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
