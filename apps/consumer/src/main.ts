import 'dotenv/config';

/**
 * Worker consumidor (skeleton — Fase 0).
 * O Módulo 2 (Event Pipeline) pluga aqui: consumir Kafka → dedup (Redis) →
 * enrich (geo/device) → batch insert no ClickHouse (PRD §7 M2).
 */
async function main() {
  // eslint-disable-next-line no-console
  console.log('[truvo/consumer] worker skeleton no ar — aguardando o pipeline do M2');
}

void main();
