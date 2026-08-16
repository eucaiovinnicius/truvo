/**
 * Flags de release avaliadas exclusivamente no backend e no contexto do workspace
 * autenticado. Ausência e chaves desconhecidas retornam false (fail-closed).
 *
 * Formato de TRUVO_FEATURE_FLAGS:
 * {"default":{"new-radar":false},"workspaces":{"workspace-id":{"new-radar":true}}}
 */
export type FeatureFlagValues = Record<string, boolean>;

export interface FeatureFlags {
  default: FeatureFlagValues;
  workspaces: Record<string, FeatureFlagValues>;
}

const EMPTY_FLAGS: FeatureFlags = { default: {}, workspaces: {} };
const FLAG_NAME = /^[a-z][a-z0-9-]{0,63}$/;

function validateValues(values: unknown, location: string): FeatureFlagValues {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${location} deve ser um objeto de flags booleanas`);
  }

  const result: FeatureFlagValues = {};
  for (const [name, enabled] of Object.entries(values)) {
    if (!FLAG_NAME.test(name) || typeof enabled !== 'boolean') {
      throw new Error(`${location}.${name} deve usar nome kebab-case e valor booleano`);
    }
    result[name] = enabled;
  }
  return result;
}

export function parseFeatureFlags(raw = process.env.TRUVO_FEATURE_FLAGS): FeatureFlags {
  if (!raw?.trim()) return EMPTY_FLAGS;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('deve ser JSON válido');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('deve ser um objeto');
  }

  const config = value as Record<string, unknown>;
  const defaults = config.default === undefined ? {} : validateValues(config.default, 'default');
  const rawWorkspaces = config.workspaces === undefined ? {} : config.workspaces;
  if (!rawWorkspaces || typeof rawWorkspaces !== 'object' || Array.isArray(rawWorkspaces)) {
    throw new Error('workspaces deve ser um objeto indexado pelo workspaceId');
  }

  const workspaces: Record<string, FeatureFlagValues> = {};
  for (const [workspaceId, flags] of Object.entries(rawWorkspaces)) {
    if (!workspaceId.trim()) throw new Error('workspaces não aceita workspaceId vazio');
    workspaces[workspaceId] = validateValues(flags, `workspaces.${workspaceId}`);
  }
  return { default: defaults, workspaces };
}

export function readFeatureFlags(): FeatureFlags {
  return parseFeatureFlags();
}

export function isFeatureEnabled(flags: FeatureFlags, workspaceId: string, flag: string): boolean {
  if (!FLAG_NAME.test(flag) || !workspaceId) return false;
  return flags.workspaces[workspaceId]?.[flag] ?? flags.default[flag] ?? false;
}
