import type { Env } from './env';

export interface CrispWelcomeConfig {
  version: 1;
  enabled: boolean;
  text: string;
}

export type CrispWelcomeStatus = 'ENABLED' | 'DISABLED' | 'UNCONFIGURED' | 'ERROR';

export interface ResolvedCrispWelcome {
  status: CrispWelcomeStatus;
  text?: string;
  source: 'D1' | 'MENU' | 'ENV' | 'NONE';
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 4000 || /[\u0000\u007f]/.test(normalized)) return null;
  return normalized;
}

export function parseCrispWelcomeConfig(value: string | undefined): CrispWelcomeConfig | null {
  if (!value || value.length > 20_000) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CrispWelcomeConfig>;
    const text = normalizeText(parsed?.text);
    if (parsed?.version !== 1 || typeof parsed.enabled !== 'boolean' || !text) return null;
    return { version: 1, enabled: parsed.enabled, text };
  } catch {
    return null;
  }
}

export function createCrispWelcomeConfig(text: string, enabled: boolean): string {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error('RUNTIME_CONFIG_VALUE_INVALID');
  return JSON.stringify({ version: 1, enabled, text: normalized } satisfies CrispWelcomeConfig);
}

export function canonicalizeCrispWelcomeConfig(value: string): string | null {
  const parsed = parseCrispWelcomeConfig(value);
  return parsed ? JSON.stringify(parsed) : null;
}

export function resolveCrispWelcome(env: Env, legacyMenuWelcome?: string): ResolvedCrispWelcome {
  const snapshot = env.runtimeConfigSnapshot;
  if (snapshot?.errors.CRISP_WELCOME_CONFIG) {
    return { status: 'ERROR', source: 'D1' };
  }

  if (snapshot?.sources.CRISP_WELCOME_CONFIG === 'D1') {
    const config = parseCrispWelcomeConfig(snapshot.values.CRISP_WELCOME_CONFIG);
    if (!config) return { status: 'ERROR', source: 'D1' };
    return {
      status: config.enabled ? 'ENABLED' : 'DISABLED',
      text: config.text,
      source: 'D1'
    };
  }

  if (typeof legacyMenuWelcome === 'string' && legacyMenuWelcome.trim()) {
    return { status: 'ENABLED', text: legacyMenuWelcome, source: 'MENU' };
  }
  if (typeof env.CRISP_WELCOME_TEXT === 'string' && env.CRISP_WELCOME_TEXT.trim()) {
    return { status: 'ENABLED', text: env.CRISP_WELCOME_TEXT, source: 'ENV' };
  }
  return { status: 'UNCONFIGURED', source: 'NONE' };
}
