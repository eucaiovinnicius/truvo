/**
 * M16 — MODO SQL GUARDADO · allowlist sintático (código de segurança).
 *
 * Roda ANTES de qualquer contato com o ClickHouse (POST /v1/explorer/sql/validate)
 * e é a 1ª camada da defesa em profundidade. NÃO substitui o sandbox de infra
 * (usuário read-only + ROW POLICY + QUOTA + pool de leitura dedicado), que é a
 * autoridade final de isolamento — ver 08-explorer.sql (// TODO(live)). Aqui
 * garantimos, por análise léxica conservadora, que o SQL do cliente é:
 *   · UM único SELECT (ou WITH … SELECT) — sem múltiplos statements;
 *   · SEM DDL/DML/controle: INSERT/UPDATE/DELETE/ALTER/CREATE/DROP/RENAME/ATTACH/
 *     DETACH/TRUNCATE/OPTIMIZE/SYSTEM/SET/GRANT/REVOKE/KILL/USE/INTO OUTFILE…;
 *   · SEM funções perigosas: system, file, url, remote, remoteSecure, s3, hdfs,
 *     mysql, postgresql, jdbc, odbc, executable, input, dictGet-família, funções
 *     de cluster e generateRandom;
 *   · SÓ referencia tabelas do namespace `explorer.*` do workspace (allowlist),
 *     nunca `system.*`/`default.*`/qualquer outro banco.
 *
 * // TODO(live): em produção, trocar este tokenizer heurístico por um PARSE real
 * do dialeto ClickHouse (AST) — mais robusto contra ofuscação. A cinta de segurança
 * autoritativa continua sendo a ROW POLICY + usuário read-only (mesmo que o parser
 * seja contornado, nenhuma linha de outro workspace é visível).
 */

/** Tabelas lógicas liberadas no namespace do explorer (views por workspace). */
export const ALLOWED_TABLES = ['events', 'touchpoints', 'sessions', 'conversions'] as const;
const ALLOWED_TABLE_SET = new Set<string>(ALLOWED_TABLES);
const ALLOWED_DB = 'explorer';

/** Palavras-chave proibidas (DDL/DML/controle). Word-boundary, case-insensitive. */
const FORBIDDEN_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'alter',
  'create',
  'drop',
  'rename',
  'attach',
  'detach',
  'truncate',
  'optimize',
  'system',
  'grant',
  'revoke',
  'kill',
  'use',
  'set',
  'into',
  'outfile',
  'infile',
  // 'replace' NÃO entra: `replace()`/`replaceRegexpAll()` são funções read-only
  // legítimas. O risco (CREATE OR REPLACE) já é coberto por bloquear 'create'.
];

/** Funções/table-functions proibidas (exfiltração/DoS/quebra de isolamento). */
const FORBIDDEN_FUNCTIONS = [
  'system',
  'file',
  'url',
  'remote',
  'remotesecure',
  's3',
  's3cluster',
  'hdfs',
  'mysql',
  'postgresql',
  'jdbc',
  'odbc',
  'executable',
  'input',
  'cluster',
  'clusterallreplicas',
  'urlcluster',
  'azureblobstorage',
  'deltalake',
  'hudi',
  'iceberg',
  'gcs',
  'generaterandom',
  'merge',
  'view',
  'numbers_mt',
  'zeros',
  'zeros_mt',
  'joinget',
];

const MAX_SQL_LENGTH = 20_000;

export interface SqlValidation {
  ok: boolean;
  reason?: string;
  /** SQL sem comentários e com literais mascarados (auditoria/telemetria). */
  normalized?: string;
  /** Tabelas do allowlist referenciadas. */
  tables?: string[];
  /** Custo estimado (// TODO(live): EXPLAIN ESTIMATE no pool de leitura). */
  estimatedCost?: null;
}

function fail(reason: string): SqlValidation {
  return { ok: false, reason };
}

/**
 * Remove comentários (linha `-- …` e `# …`, e bloco estilo C) e mascara literais
 * de string (`'…'` com escape `''`) por `''`, para que nenhuma keyword/nome seja
 * "escondida" dentro de uma string. Preserva identificadores com backticks/aspas.
 */
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // line comments
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // single-quoted string literal → mask to ''
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Extrai nomes de CTE (`WITH a AS (…) , b AS (…)`) p/ não confundir com tabelas. */
function collectCteNames(normalized: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:\bwith\b|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const name = m[1];
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

/**
 * Valida cada alvo de FROM/JOIN: deve ser um subquery `(`, um CTE conhecido, ou uma
 * tabela do allowlist — bare (`events`) ou qualificada como `explorer.<tabela>`.
 * Qualquer outro banco (`system.*`, `default.*`, …) → falha.
 */
function validateTableRefs(normalized: string, ctes: Set<string>): SqlValidation {
  const used = new Set<string>();
  // Captura o token logo após FROM/JOIN (ignora subquery `(`).
  const re = /\b(?:from|join)\b\s+([^\s(,)]+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const rawFull = m[1];
    if (rawFull === undefined) {
      // FROM seguido de subquery `(` → ok (o conteúdo é validado globalmente).
      continue;
    }
    const raw = rawFull.replace(/`/g, '').replace(/"/g, '').toLowerCase();
    if (raw.length === 0) continue;

    if (raw.includes('.')) {
      const parts = raw.split('.');
      const db = parts[0];
      const tbl = parts[1];
      if (db !== ALLOWED_DB || !tbl || !ALLOWED_TABLE_SET.has(tbl)) {
        return fail(`tabela fora do namespace 'explorer.*': '${rawFull}'`);
      }
      used.add(tbl);
    } else {
      if (ctes.has(raw)) continue; // referência a um CTE, não a uma tabela física
      if (!ALLOWED_TABLE_SET.has(raw)) {
        return fail(`tabela não permitida: '${rawFull}'`);
      }
      used.add(raw);
    }
  }
  return { ok: true, tables: [...used] };
}

/**
 * Valida o SQL do cliente. Retorna `{ ok:false, reason }` em qualquer violação
 * (o service traduz para 422). Conservador por design: na dúvida, rejeita.
 */
export function validateGuardedSql(input: string): SqlValidation {
  const trimmed = input.trim();
  if (!trimmed) return fail('SQL vazio');
  if (trimmed.length > MAX_SQL_LENGTH) return fail('SQL longo demais');

  const normalized = stripCommentsAndStrings(trimmed).trim();

  // 1 statement só: no máximo um `;` e apenas como terminador.
  const withoutTrailing = normalized.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return fail('apenas um único statement é permitido (sem ";")');
  }

  // Deve começar com SELECT ou WITH.
  if (!/^(with|select)\b/i.test(withoutTrailing)) {
    return fail('apenas um único SELECT (ou WITH … SELECT) é permitido');
  }

  // Palavras-chave proibidas (word-boundary).
  const lower = withoutTrailing.toLowerCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(lower)) {
      return fail(`palavra-chave não permitida: '${kw.toUpperCase()}'`);
    }
  }

  // Funções perigosas: nome seguido de `(`.
  const callRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  let call: RegExpExecArray | null;
  while ((call = callRe.exec(withoutTrailing)) !== null) {
    const fn = (call[1] ?? '').toLowerCase();
    if (FORBIDDEN_FUNCTIONS.includes(fn)) {
      return fail(`função não permitida: '${fn}()'`);
    }
    // dictGet, dictGetString, dictGetOrDefault, … — família inteira bloqueada.
    if (fn.startsWith('dictget') || fn.startsWith('dicthas') || fn.startsWith('dictgethierarchy')) {
      return fail(`função de dicionário não permitida: '${fn}()'`);
    }
    // Qualquer *cluster()/*Cluster().
    if (fn.endsWith('cluster')) {
      return fail(`função de cluster não permitida: '${fn}()'`);
    }
  }

  // Referências a tabelas: só explorer.* do allowlist (ou CTE/subquery).
  const ctes = collectCteNames(withoutTrailing);
  const tableCheck = validateTableRefs(withoutTrailing, ctes);
  if (!tableCheck.ok) return tableCheck;

  return {
    ok: true,
    normalized: withoutTrailing,
    tables: tableCheck.tables ?? [],
    estimatedCost: null,
  };
}
