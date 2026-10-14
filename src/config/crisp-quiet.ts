import { Env } from './env';

export const CRISP_QUIET_KEY = 'TELEGRAM_CRISP_HUMAN_QUIET_MINUTES' as const;
export const CRISP_QUIET_DEFAULT_MINUTES = 15;

export function parseCrispQuietMinutes(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value.trim())) return null;
  const minutes = Number(value.trim());
  return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null;
}

export function crispQuietMinutes(env: Env): number {
  // An invalid present override never falls back to an older ENV value.
  // The finite 15-minute safety default also cannot create permanent silence.
  if (env.runtimeConfigSnapshot?.errors[CRISP_QUIET_KEY]) return CRISP_QUIET_DEFAULT_MINUTES;
  const value = env.runtimeConfigSnapshot?.values[CRISP_QUIET_KEY] ?? env[CRISP_QUIET_KEY];
  return parseCrispQuietMinutes(value) ?? CRISP_QUIET_DEFAULT_MINUTES;
}
