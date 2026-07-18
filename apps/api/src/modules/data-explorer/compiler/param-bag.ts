/**
 * M16 — ParamBag: registra valores do cliente como parâmetros server-side do
 * ClickHouse (`{nome:Tipo}`) e devolve o placeholder. NUNCA interpola valores no
 * SQL — é o mecanismo que elimina injeção (regra 19). Nomes gerados são únicos
 * (`p0`, `p1`, …) e não colidem com os params reservados do compilador
 * (`ws`, `start`, `end`, e prefixos de retenção/steps).
 */

export type ChParamType =
  | 'String'
  | 'Float64'
  | 'Int64'
  | 'UInt8'
  | 'UInt32'
  | 'DateTime64(3)'
  | 'Array(String)'
  | 'Array(Float64)';

export class ParamBag {
  private seq = 0;
  readonly params: Record<string, unknown> = {};

  /** Vincula `value` como `{pN:type}` e devolve o placeholder pronto p/ o SQL. */
  bind(value: unknown, type: ChParamType): string {
    const name = `p${this.seq++}`;
    this.params[name] = value;
    return `{${name}:${type}}`;
  }

  /** Vincula com um nome fixo (params reservados: ws/start/end). */
  bindNamed(name: string, value: unknown, type: ChParamType): string {
    this.params[name] = value;
    return `{${name}:${type}}`;
  }
}
