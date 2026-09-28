import { Env } from '../../config/env';
import { crispAuth } from './api';

const CRISP_API_BASE = 'https://api.crisp.chat/v1';
const META_TIMEOUT_MS = 5000;
const META_MAX_BYTES = 64 * 1024;

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
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) return undefined;
  return normalized;
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
    const ip = safeIp(data.ip);
    const country = safeLocationPart(geo.country, 16);
    const region = safeLocationPart(geo.region, 64);
    const city = safeLocationPart(geo.city, 128);
    return {
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
  const lines = ['🌍 Crisp 访客位置'];
  if (context.ip) lines.push(`IP：${context.ip}`);
  if (location) lines.push(`地区（IP 解析）：${location}`);
  return lines.length > 1 ? lines.join('\n') : null;
}
