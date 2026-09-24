import { Env } from './env';

export interface CrispDisplayIdentity {
  nickname: string;
  avatar?: string;
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

export function validateCrispNickname(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > 64 || CONTROL_PATTERN.test(normalized)) return null;
  return normalized;
}

export function validateCrispAvatarUrl(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2048 || CONTROL_PATTERN.test(normalized)) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function identity(
  env: Env,
  nicknameKey: 'CRISP_OPERATOR_NICKNAME' | 'CRISP_AI_NICKNAME',
  avatarKey: 'CRISP_OPERATOR_AVATAR_URL' | 'CRISP_AI_AVATAR_URL',
  fallbackNickname: string
): CrispDisplayIdentity {
  const snapshot = env.runtimeConfigSnapshot;
  const configuredNickname = snapshot?.values[nicknameKey] ?? env[nicknameKey];
  const nickname = configuredNickname ? validateCrispNickname(configuredNickname) : fallbackNickname;
  if (!nickname) throw new Error('Invalid Crisp display nickname');
  const configuredAvatar = snapshot?.values[avatarKey] ?? env[avatarKey];
  const avatar = configuredAvatar ? validateCrispAvatarUrl(configuredAvatar) : null;
  return { nickname, ...(avatar ? { avatar } : {}) };
}

export function crispOperatorIdentity(env: Env): CrispDisplayIdentity {
  return identity(env, 'CRISP_OPERATOR_NICKNAME', 'CRISP_OPERATOR_AVATAR_URL', '人工客服');
}

export function crispAiIdentity(env: Env): CrispDisplayIdentity {
  return identity(env, 'CRISP_AI_NICKNAME', 'CRISP_AI_AVATAR_URL', '智能客服');
}

export interface CrispIdentityRequestOptions {
  version: 1;
  crispIdentity: CrispDisplayIdentity;
}

export function crispIdentityRequestOptions(identityValue: CrispDisplayIdentity): CrispIdentityRequestOptions {
  return { version: 1, crispIdentity: identityValue };
}

export function parseCrispIdentityRequestOptions(value: string | null | undefined): CrispDisplayIdentity | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.version !== 1 || !parsed.crispIdentity || typeof parsed.crispIdentity !== 'object' || Array.isArray(parsed.crispIdentity)) {
      return null;
    }
    const user = parsed.crispIdentity as Record<string, unknown>;
    if (typeof user.nickname !== 'string') return null;
    const nickname = validateCrispNickname(user.nickname);
    if (!nickname) return null;
    const keys = Object.keys(user).sort().join(',');
    if (keys !== 'nickname' && keys !== 'avatar,nickname') return null;
    if (user.avatar === undefined) return { nickname };
    if (typeof user.avatar !== 'string') return null;
    const avatar = validateCrispAvatarUrl(user.avatar);
    return avatar ? { nickname, avatar } : null;
  } catch {
    return null;
  }
}
