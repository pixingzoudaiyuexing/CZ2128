import { Env } from '../../config/env';
import { crispAuth } from './api';

const CRISP_API_BASE = 'https://api.crisp.chat/v1';
const META_TIMEOUT_MS = 5000;
const META_MAX_BYTES = 64 * 1024;
const CARD_MAX_CHARS = 3500;
const CUSTOM_MAX_FIELDS = 20;
const CUSTOM_KEY_MAX_CHARS = 64;
const CUSTOM_VALUE_MAX_CHARS = 256;
const STANDARD_TEXT_MAX_CHARS = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CUSTOM_DENYLIST = /(^|[._ -])(lat|latitude|lng|lon|longitude|coordinates?|isp|asn|device|browser|user[._ -]?agent|authorization|api[._ -]?key|password|secret|token|credential)s?($|[._ -])/i;
const CUSTOM_STANDARD_KEYS = new Set([
  'nickname', 'name', 'email', 'phone', 'address', 'subject', 'segments',
  'ip', 'geolocation', 'location'
]);
const ADDRESS_KEYS = new Set([
  'address', 'street', 'line1', 'line2', 'city', 'region', 'state',
  'postal_code', 'postcode', 'zip', 'zipcode', 'country'
]);

export type CrispVisitorContextFailure =
  | 'AUTH_MISSING'
  | 'HTTP'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'REDIRECT'
  | 'INVALID_RESPONSE'
  | 'TOO_LARGE';

export class CrispVisitorContextError extends Error {
  constructor(
    readonly reason: CrispVisitorContextFailure,
    readonly httpStatus?: number
  ) {
    super(reason);
    this.name = 'CrispVisitorContextError';
  }
}

export interface CrispVisitorContext {
  nickname?: string;
  email?: string;
  phone?: string;
  address?: string;
  subject?: string;
  segments?: string[];
  customData?: Array<{ key: string; value: string }>;
  customDataTruncated?: boolean;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
}

function safeIp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 64 ||
    !/^[0-9A-Fa-f:.]+$/.test(normalized)
  ) return undefined;
  return normalized;
}

function safeLocationPart(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    CONTROL_CHARACTERS.test(normalized)
  ) return undefined;
  return normalized;
}

function safeText(value: unknown, maximum = STANDARD_TEXT_MAX_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARACTERS.test(normalized)) return undefined;
  return Array.from(normalized).slice(0, maximum).join('');
}

function safeAddress(value: unknown): string | undefined {
  const direct = safeText(value, STANDARD_TEXT_MAX_CHARS);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => ADDRESS_KEYS.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 8)
    .map(([, part]) => safeText(part, 128))
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? Array.from(parts.join(' · ')).slice(0, STANDARD_TEXT_MAX_CHARS).join('') : undefined;
}

function safeSegments(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value
    .map(item => safeText(item, 64))
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
  return segments.length > 0 ? segments : undefined;
}

function safeCustomKey(value: string): string | undefined {
  const normalized = value.trim();
  if (
    !normalized ||
    Array.from(normalized).length > CUSTOM_KEY_MAX_CHARS ||
    CONTROL_CHARACTERS.test(normalized) ||
    CUSTOM_DENYLIST.test(normalized)
  ) return undefined;
  return normalized;
}

function safeCustomPrimitive(value: unknown): string | undefined {
  if (typeof value === 'string') return safeText(value, CUSTOM_VALUE_MAX_CHARS);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, CUSTOM_VALUE_MAX_CHARS);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function flattenCustomData(value: unknown): { fields: Array<{ key: string; value: string }>; truncated: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { fields: [], truncated: false };
  }
  const fields: Array<{ key: string; value: string }> = [];
  let truncated = false;
  const visit = (object: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [rawKey, rawValue] of Object.entries(object).sort(([a], [b]) => a.localeCompare(b))) {
      if (fields.length >= CUSTOM_MAX_FIELDS) {
        truncated = true;
        return;
      }
      const keyPart = safeCustomKey(rawKey);
      if (!keyPart) continue;
      if (depth === 0 && CUSTOM_STANDARD_KEYS.has(keyPart.toLowerCase())) continue;
      const key = prefix ? `${prefix}.${keyPart}` : keyPart;
      if (Array.from(key).length > CUSTOM_KEY_MAX_CHARS || CUSTOM_DENYLIST.test(key)) continue;
      const primitive = safeCustomPrimitive(rawValue);
      if (primitive !== undefined) {
        fields.push({ key, value: primitive });
        continue;
      }
      if (
        depth < 1 &&
        rawValue &&
        typeof rawValue === 'object' &&
        !Array.isArray(rawValue)
      ) {
        visit(rawValue as Record<string, unknown>, key, depth + 1);
      }
    }
  };
  visit(value as Record<string, unknown>, '', 0);
  return { fields, truncated };
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('Content-Length') || '');
  if (Number.isFinite(declared) && declared > META_MAX_BYTES) {
    throw new CrispVisitorContextError('TOO_LARGE');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > META_MAX_BYTES) {
      throw new CrispVisitorContextError('TOO_LARGE');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > META_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new CrispVisitorContextError('TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* no-op */ }
  }
}

export async function fetchCrispVisitorContext(
  env: Env,
  websiteRef: string,
  sessionRef: string
): Promise<CrispVisitorContext> {
  let authorization: string;
  try {
    authorization = crispAuth(env);
  } catch {
    throw new CrispVisitorContextError('AUTH_MISSING');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  const url = `${CRISP_API_BASE}/website/${encodeURIComponent(websiteRef)}/conversation/${encodeURIComponent(sessionRef)}/meta`;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'X-Crisp-Tier': 'plugin'
        },
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CrispVisitorContextError('TIMEOUT');
      }
      throw new CrispVisitorContextError('TRANSPORT');
    }

    if (response.status >= 300 && response.status < 400) {
      throw new CrispVisitorContextError('REDIRECT', response.status);
    }
    if (!response.ok) throw new CrispVisitorContextError('HTTP', response.status);

    let payload: any;
    try {
      payload = JSON.parse(await readBoundedText(response));
    } catch (error) {
      if (error instanceof CrispVisitorContextError) throw error;
      throw new CrispVisitorContextError('INVALID_RESPONSE');
    }
    const data = payload?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CrispVisitorContextError('INVALID_RESPONSE');
    }
    const geo = data.geolocation && typeof data.geolocation === 'object' && !Array.isArray(data.geolocation)
      ? data.geolocation
      : {};
    const custom = flattenCustomData(data.data);
    const nickname = safeText(data.nickname ?? data.user?.nickname);
    const email = safeText(data.email ?? data.data?.email);
    const phone = safeText(data.phone ?? data.data?.phone);
    const address = safeAddress(data.address ?? data.data?.address);
    const subject = safeText(data.subject ?? data.data?.subject);
    const segments = safeSegments(data.segments ?? data.data?.segments);
    const ip = safeIp(data.ip);
    const country = safeLocationPart(geo.country, 16);
    const region = safeLocationPart(geo.region, 64);
    const city = safeLocationPart(geo.city, 128);
    return {
      ...(nickname ? { nickname } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(address ? { address } : {}),
      ...(subject ? { subject } : {}),
      ...(segments ? { segments } : {}),
      ...(custom.fields.length > 0 ? { customData: custom.fields } : {}),
      ...(custom.truncated ? { customDataTruncated: true } : {}),
      ...(ip ? { ip } : {}),
      ...(country ? { country } : {}),
      ...(region ? { region } : {}),
      ...(city ? { city } : {})
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function formatCrispVisitorContext(context: CrispVisitorContext): string | null {
  const location = [context.country, context.region, context.city].filter(Boolean).join(' · ');
  const identity = [
    ...(context.nickname ? [`昵称：${context.nickname}`] : []),
    ...(context.email ? [`邮箱：${context.email}`] : []),
    ...(context.phone ? [`电话：${context.phone}`] : []),
    ...(context.address ? [`地址：${context.address}`] : []),
    ...(context.subject ? [`主题：${context.subject}`] : []),
    ...(context.segments?.length
      ? [`标签：${Array.from(context.segments.join(' · ')).slice(0, 256).join('')}`]
      : [])
  ];
  const locationLines = [
    ...(context.ip ? [`IP：${context.ip}`] : []),
    ...(location ? [`地区：${location}`] : [])
  ];
  let custom = (context.customData || []).map(item => `${item.key}：${item.value}`);
  let truncated = context.customDataTruncated === true;
  const render = (): string => {
    const sections = [
      ...(identity.length > 0 ? [['👤 客户资料', ...identity].join('\n')] : []),
      ...(custom.length > 0 || truncated
        ? [['📋 访客资料', ...custom, ...(truncated ? ['…还有更多资料未显示'] : [])].join('\n')]
        : []),
      ...(locationLines.length > 0 ? [['🌍 访客位置', ...locationLines].join('\n')] : [])
    ];
    return sections.join('\n\n');
  };
  let card = render();
  while (custom.length > 0 && Array.from(card).length > CARD_MAX_CHARS) {
    custom = custom.slice(0, -1);
    truncated = true;
    card = render();
  }
  return card && Array.from(card).length <= CARD_MAX_CHARS ? card : null;
}