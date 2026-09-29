import type { Env } from '../config/env';
import type { CrispMessageEvent } from '../core/events';
import { logger } from '../observability/logger';
import { io, type Socket } from 'socket.io-client';

const CRISP_CONNECT_ENDPOINTS = 'https://api.crisp.chat/v1/plugin/connect/endpoints';
const RTM_INSTANCE_NAME = 'crisp-primary';
const RTM_ENDPOINT_TIMEOUT_MS = 5_000;
const RTM_ENDPOINT_MAX_BYTES = 64 * 1024;
const HEALTHY_ALARM_MS = 5 * 60 * 1000;
const CONNECTING_ALARM_MS = 10 * 1000;
const RECONNECT_ALARM_MS = 5 * 1000;

type CrispConnectEndpointsResponse = {
  data?: { socket?: { app?: unknown } };
};

export type CrispRtmSocketTarget = {
  origin: string;
  path: string;
};

export function buildCrispRtmAuthentication(env: Env): {
  tier: 'plugin';
  username: string;
  password: string;
  events: ['message:send'];
} {
  if (!env.CRISP_API_IDENTIFIER || !env.CRISP_API_KEY) {
    throw new Error('CRISP_RTM_AUTH_MISSING');
  }
  return {
    tier: 'plugin',
    username: env.CRISP_API_IDENTIFIER,
    password: env.CRISP_API_KEY,
    events: ['message:send']
  };
}

async function readBoundedRtmEndpointResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > RTM_ENDPOINT_MAX_BYTES) {
    throw new Error('CRISP_RTM_ENDPOINT_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RTM_ENDPOINT_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error('CRISP_RTM_ENDPOINT_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* no-op */ }
  }
}

export async function fetchCrispRtmSocketEndpoint(env: Env): Promise<string> {
  if (!env.CRISP_API_IDENTIFIER || !env.CRISP_API_KEY) {
    throw new Error('CRISP_RTM_AUTH_MISSING');
  }
  const authorization = `Basic ${btoa(`${env.CRISP_API_IDENTIFIER}:${env.CRISP_API_KEY}`)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RTM_ENDPOINT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(CRISP_CONNECT_ENDPOINTS, {
        method: 'GET',
        headers: {
          Authorization: authorization,
          'X-Crisp-Tier': 'plugin',
          Accept: 'application/json'
        },
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('CRISP_RTM_ENDPOINT_TIMEOUT');
      }
      throw new Error('CRISP_RTM_ENDPOINT_TRANSPORT');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error('CRISP_RTM_ENDPOINT_REDIRECT');
    }
    if (!response.ok) throw new Error('CRISP_RTM_ENDPOINT_HTTP');
    let payload: CrispConnectEndpointsResponse;
    try {
      payload = JSON.parse(await readBoundedRtmEndpointResponse(response)) as CrispConnectEndpointsResponse;
    } catch (error) {
      if (error instanceof Error && error.message === 'CRISP_RTM_ENDPOINT_TOO_LARGE') throw error;
      throw new Error('CRISP_RTM_ENDPOINT_INVALID_RESPONSE');
    }
    const endpoint = payload.data?.socket?.app;
    if (typeof endpoint !== 'string' || !endpoint) throw new Error('CRISP_RTM_ENDPOINT_MISSING');
    const target = buildCrispRtmSocketTarget(endpoint);
    return `${target.origin}${target.path}`;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildCrispRtmSocketTarget(endpoint: string): CrispRtmSocketTarget {
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:' || (url.hostname !== 'crisp.chat' && !url.hostname.endsWith('.crisp.chat'))) {
    throw new Error('CRISP_RTM_ENDPOINT_INVALID');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  return { origin: url.origin, path: url.pathname };
}

export function normalizeCrispRtmMessage(
  data: unknown,
  expectedWebsiteId?: string
): CrispMessageEvent | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, any>;
  if (message.type !== 'text' || message.from !== 'user') return null;
  if (typeof message.website_id !== 'string' || typeof message.session_id !== 'string') return null;
  if (expectedWebsiteId && message.website_id !== expectedWebsiteId) return null;
  if (message.fingerprint === undefined || message.fingerprint === null) return null;
  if (typeof message.content !== 'string' || !message.content) return null;

  const fingerprint = String(message.fingerprint);
  const customerRef = typeof message.user?.user_id === 'string' && message.user.user_id
    ? message.user.user_id
    : `session:${message.session_id}`;
  const customerName = typeof message.user?.nickname === 'string' && message.user.nickname.trim()
    ? message.user.nickname.trim()
    : undefined;

  return {
    version: 1,
    source: 'crisp',
    type: 'message_created',
    eventId: `crisp:${message.website_id}:${message.session_id}:message:send:${fingerprint}`,
    payload: {
      websiteRef: message.website_id,
      sessionRef: message.session_id,
      customerRef,
      ...(customerName ? { customerName } : {}),
      messageRef: fingerprint,
      actorRole: 'CUSTOMER',
      content: message.content
    }
  };
}

function hasRtmConfig(env: Env): env is Env & {
  CRISP_RTM: DurableObjectNamespace;
  CRISP_API_IDENTIFIER: string;
  CRISP_API_KEY: string;
  CRISP_WEBSITE_ID: string;
} {
  return Boolean(env.CRISP_RTM && env.CRISP_API_IDENTIFIER && env.CRISP_API_KEY && env.CRISP_WEBSITE_ID);
}

export async function kickCrispRtm(env: Env): Promise<void> {
  if (!hasRtmConfig(env)) return;
  const id = env.CRISP_RTM.idFromName(RTM_INSTANCE_NAME);
  const response = await env.CRISP_RTM.get(id).fetch('https://crisp-rtm.internal/start', { method: 'POST' });
  if (!response.ok) throw new Error('CRISP_RTM_WAKE_FAILED');
}

export class CrispRtmBridge {
  private socket?: Socket;
  private authenticated = false;
  private connectingSince = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    await this.ensureConnected();
    return Response.json({
      ok: true,
      state: this.authenticated ? 'authenticated' : this.socket ? 'connecting' : 'idle'
    });
  }

  async alarm(): Promise<void> {
    await this.ensureConnected();
  }

  private async setAlarm(delayMs: number): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + delayMs);
  }

  private async fetchSocketEndpoint(): Promise<string> {
    return fetchCrispRtmSocketEndpoint(this.env);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.env.CRISP_WEBSITE_ID || !this.env.CRISP_API_IDENTIFIER || !this.env.CRISP_API_KEY) return;

    if (this.socket?.connected && this.authenticated) {
      await this.setAlarm(HEALTHY_ALARM_MS);
      return;
    }
    // Socket.IO owns transport reconnects once a client instance is active.
    // The Durable Object alarm is only a watchdog/wake-up mechanism; it must
    // not create a second client while Socket.IO is already reconnecting.
    if (this.socket?.active) {
      await this.setAlarm(CONNECTING_ALARM_MS);
      return;
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.socket = undefined;
    this.authenticated = false;

    try {
      const target = buildCrispRtmSocketTarget(await this.fetchSocketEndpoint());
      const socket = io(target.origin, {
        path: target.path,
        transports: ['websocket'],
        timeout: 10_000,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 5_000,
        randomizationFactor: 0.5,
        autoConnect: false
      });
      this.socket = socket;
      this.connectingSince = Date.now();

      socket.on('connect', () => {
        if (this.socket !== socket) return;
        this.connectingSince = Date.now();
        socket.emit('authentication', buildCrispRtmAuthentication(this.env));
      });

      socket.on('authenticated', () => {
        if (this.socket !== socket) return;
        this.authenticated = true;
        this.connectingSince = 0;
        logger.info('Crisp RTM authenticated', { source: 'crisp', stage: 'RTM', result: 'SUCCESS' });
        this.state.waitUntil(this.setAlarm(HEALTHY_ALARM_MS));
      });

      socket.on('unauthorized', () => {
        if (this.socket !== socket) return;
        this.authenticated = false;
        logger.warn('Crisp RTM authentication rejected', { source: 'crisp', stage: 'RTM' });
        socket.disconnect();
        this.state.waitUntil(this.setAlarm(HEALTHY_ALARM_MS));
      });

      socket.on('message:send', data => {
        if (this.socket !== socket) return;
        this.state.waitUntil(this.handleRtmCustomerMessage(data));
      });

      socket.on('disconnect', () => {
        if (this.socket === socket) {
          this.authenticated = false;
          this.connectingSince = Date.now();
        }
        logger.warn('Crisp RTM disconnected', { source: 'crisp', stage: 'RTM' });
        this.state.waitUntil(this.setAlarm(RECONNECT_ALARM_MS));
      });

      socket.on('connect_error', () => {
        logger.warn('Crisp RTM socket error', { source: 'crisp', stage: 'RTM' });
        this.state.waitUntil(this.setAlarm(RECONNECT_ALARM_MS));
      });

      socket.connect();
      await this.setAlarm(CONNECTING_ALARM_MS);
    } catch {
      this.socket?.removeAllListeners();
      this.socket?.disconnect();
      this.socket = undefined;
      this.authenticated = false;
      logger.warn('Crisp RTM connection setup failed', { source: 'crisp', stage: 'RTM' });
      await this.setAlarm(RECONNECT_ALARM_MS);
    }
  }

  private async handleRtmCustomerMessage(data: unknown): Promise<void> {
    const event = normalizeCrispRtmMessage(data, this.env.CRISP_WEBSITE_ID);
    if (!event) return;
    await this.env.QUEUE.send(event);
    logger.info('Crisp RTM customer event enqueued', {
      source: 'crisp',
      stage: 'RTM',
      result: 'SUCCESS'
    });
  }
}
