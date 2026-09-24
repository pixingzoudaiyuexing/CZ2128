import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { SqliteD1 } from './helpers/sqlite-d1';

type ProviderKind = 'telegram-topic' | 'telegram-message' | 'crisp-text' | 'crisp-picker';
type ProviderCall = { kind: ProviderKind; count: number; body: any };

function baseMenu() {
  return {
    picker: {
      id: 'main',
      text: '请选择服务',
      choices: [{ value: 'plans', label: '查看套餐' }]
    },
    options: [{
      pickerId: 'main',
      value: 'plans',
      label: '查看套餐',
      response: '套餐说明'
    }]
  };
}

function crispEvent(eventId: string, messageRef: string, content = 'Hello') {
  return {
    version: 1,
    source: 'crisp',
    type: 'message_created',
    eventId,
    payload: {
      websiteRef: 'website-1',
      sessionRef: 'session-1',
      customerRef: 'visitor-1',
      messageRef,
      actorRole: 'CUSTOMER',
      content
    }
  } as any;
}

function testEnv(db: SqliteD1, menu = baseMenu()) {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() },
    BOT_GROUP_ID: '-100',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    CRISP_API_IDENTIFIER: 'crisp-id',
    CRISP_API_KEY: 'crisp-key',
    CRISP_WELCOME_TEXT: 'Welcome',
    CRISP_MENU_JSON: JSON.stringify(menu)
  } as any;
}

function success(kind: ProviderKind, count: number): Response {
  if (kind === 'telegram-topic') {
    return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 77 } }), { status: 200 });
  }
  if (kind === 'telegram-message') {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + count } }), { status: 200 });
  }
  return new Response(JSON.stringify({ data: { fingerprint: `${kind}-${count}` } }), { status: 200 });
}

function rateLimited(): Response {
  return new Response(JSON.stringify({ error: true }), {
    status: 429,
    headers: { 'Retry-After': '1' }
  });
}

function installProviders(
  behavior: (call: ProviderCall) => Response | undefined
): { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const counts: Record<ProviderKind, number> = {
    'telegram-topic': 0,
    'telegram-message': 0,
    'crisp-text': 0,
    'crisp-picker': 0
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    let body: any = {};
    if (init?.body) body = JSON.parse(String(init.body));
    let kind: ProviderKind;
    if (url.includes('api.telegram.org') && url.endsWith('/createForumTopic')) {
      kind = 'telegram-topic';
    } else if (url.includes('api.telegram.org') && url.endsWith('/sendMessage')) {
      kind = 'telegram-message';
    } else if (url.includes('api.crisp.chat') && body.type === 'picker') {
      kind = 'crisp-picker';
    } else if (url.includes('api.crisp.chat') && body.type === 'text') {
      kind = 'crisp-text';
    } else {
      throw new Error(`Unexpected provider request: ${url}`);
    }
    counts[kind] += 1;
    const call = { kind, count: counts[kind], body };
    calls.push(call);
    return behavior(call) || success(kind, counts[kind]);
  });
  return { calls };
}

async function receipt(db: SqliteD1, eventId: string) {
  return db.prepare(
    `SELECT status, attempt_count, last_error
     FROM event_receipts WHERE source = 'crisp' AND source_event_ref = ?`
  ).bind(eventId).first<any>();
}

async function conversation(db: SqliteD1) {
  return db.prepare(
    `SELECT id, operator_thread_ref, ai_mode
     FROM conversations WHERE helpdesk_provider = 'crisp' AND helpdesk_conversation_ref = 'session-1'`
  ).first<any>();
}

async function outboundCount(db: SqliteD1, pattern: string) {
  return (await db.prepare(
    'SELECT COUNT(*) AS count FROM outbound_operations WHERE id LIKE ?'
  ).bind(pattern).first<{ count: number }>())?.count || 0;
}

async function outbound(db: SqliteD1, pattern: string) {
  return db.prepare(
    `SELECT id, status, attempt_count, request_started_at, response_observed_at,
            response_http_status, reconciliation_status
     FROM outbound_operations WHERE id LIKE ? LIMIT 1`
  ).bind(pattern).first<any>();
}

async function auditState(db: SqliteD1, action: string) {
  return db.prepare(
    'SELECT old_state, new_state FROM reliability_audit WHERE action = ? LIMIT 1'
  ).bind(action).first<any>();
}

function withPickerSentPersistFailure(db: SqliteD1) {
  let failed = false;
  return {
    prepare(query: string) {
      const statement: any = db.prepare(query);
      if (!query.includes("SET status = 'SENT'")) return statement;
      return {
        bind(...args: any[]) {
          const bound: any = statement.bind(...args);
          return {
            async run() {
              const operationId = args[2];
              if (!failed && typeof operationId === 'string' && operationId.startsWith('crisp_picker:')) {
                failed = true;
                throw new Error('synthetic picker result persistence failure');
              }
              return bound.run();
            },
            first: bound.first?.bind(bound),
            all: bound.all?.bind(bound)
          };
        }
      };
    },
    batch: db.batch.bind(db)
  } as any;
}

describe('Crisp first-event bootstrap continuation on real local D1', () => {
  const databases: SqliteD1[] = [];
  let now = Date.UTC(2026, 8, 24, 9, 0, 0);

  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) db.close();
  });

  function setup(menu = baseMenu()) {
    now = Date.UTC(2026, 8, 24, 9, 0, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const db = new SqliteD1();
    db.migrate();
    databases.push(db);
    return { db, env: testEnv(db, menu) };
  }

  function advance(seconds: number) {
    now += seconds * 1000;
  }

  it('A: resumes the same first event after Telegram text gets a definite retryable response before Welcome exists', async () => {
    const { db, env } = setup();
    const providers = installProviders(call =>
      call.kind === 'telegram-message' && call.count === 1 ? rateLimited() : undefined
    );
    const event = crispEvent('crisp:first-before-welcome', 'message-first');

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'FAILED', attempt_count: 1 });
    expect(await outboundCount(db, 'crisp_welcome:%')).toBe(0);
    expect(await outboundCount(db, 'crisp_picker:%')).toBe(0);
    expect(await auditState(db, 'CRISP_BOOTSTRAP_INTENT_CREATED')).not.toBeNull();

    advance(10);
    await handleQueueEvent(event, env);

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 2 });
    expect(await outbound(db, 'crisp_welcome:%')).toMatchObject({ status: 'SENT' });
    expect(await outbound(db, 'crisp_picker:%')).toMatchObject({ status: 'SENT' });
    expect(providers.calls.filter(call => call.kind === 'crisp-text')).toHaveLength(1);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(1);
  });

  it('B: resumes Picker after a definite retryable Welcome failure on the same first event', async () => {
    const { db, env } = setup();
    const providers = installProviders(call =>
      call.kind === 'crisp-text' && call.count === 1 ? rateLimited() : undefined
    );
    const event = crispEvent('crisp:first-welcome-retry', 'message-welcome-retry');

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    expect(await outbound(db, 'crisp_welcome:%')).toMatchObject({
      status: 'FAILED_RETRYABLE',
      attempt_count: 1,
      response_http_status: 429
    });
    expect(await outboundCount(db, 'crisp_picker:%')).toBe(0);

    advance(10);
    await handleQueueEvent(event, env);

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 2 });
    expect(await outbound(db, 'crisp_welcome:%')).toMatchObject({ status: 'SENT', attempt_count: 2 });
    expect(await outbound(db, 'crisp_picker:%')).toMatchObject({ status: 'SENT' });
    expect(providers.calls.filter(call => call.kind === 'crisp-text')).toHaveLength(2);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(1);
  });

  it('C: retries only the unfinished Picker when Welcome is already SENT', async () => {
    const { db, env } = setup();
    const providers = installProviders(call =>
      call.kind === 'crisp-picker' && call.count === 1 ? rateLimited() : undefined
    );
    const event = crispEvent('crisp:first-picker-retry', 'message-picker-retry');

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    expect(await outbound(db, 'crisp_welcome:%')).toMatchObject({ status: 'SENT', attempt_count: 1 });
    expect(await outbound(db, 'crisp_picker:%')).toMatchObject({
      status: 'FAILED_RETRYABLE',
      attempt_count: 1,
      response_http_status: 429
    });

    advance(10);
    await handleQueueEvent(event, env);

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 2 });
    expect(providers.calls.filter(call => call.kind === 'crisp-text')).toHaveLength(1);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(2);
  });

  it('D: a later customer message retry never inherits the first-event bootstrap intent', async () => {
    const { db, env } = setup();
    const providers = installProviders(call =>
      call.kind === 'telegram-message' && call.count === 2 ? rateLimited() : undefined
    );
    const first = crispEvent('crisp:first-complete', 'message-first-complete');
    const later = crispEvent('crisp:later-retry', 'message-later-retry', 'Second message');

    await handleQueueEvent(first, env);
    await expect(handleQueueEvent(later, env)).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });

    advance(10);
    await handleQueueEvent(later, env);

    expect(await receipt(db, first.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 1 });
    expect(await receipt(db, later.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 2 });
    expect(providers.calls.filter(call => call.kind === 'crisp-text')).toHaveLength(1);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(1);
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit
       WHERE action IN ('CRISP_BOOTSTRAP_INTENT_CREATED', 'CRISP_BOOTSTRAP_DECISION_FIXED')`
    ).first<{ count: number }>())?.count).toBe(2);
  });

  it.each([
    ['picker id', (menu: ReturnType<typeof baseMenu>) => {
      menu.picker.id = 'changed';
      menu.options[0].pickerId = 'changed';
    }],
    ['choice value', (menu: ReturnType<typeof baseMenu>) => {
      menu.picker.choices[0].value = 'support';
      menu.options[0].value = 'support';
    }],
    ['option action', (menu: ReturnType<typeof baseMenu>) => {
      menu.options[0].response = 'changed action';
    }]
  ] as const)('E: fails closed when %s changes before the original Picker can be sent', async (_label, mutate) => {
    const menu = baseMenu();
    const { db, env } = setup(menu);
    const providers = installProviders(call =>
      call.kind === 'crisp-text' && call.count === 1 ? rateLimited() : undefined
    );
    const event = crispEvent(`crisp:menu-change:${_label}`, `message-menu-change:${_label}`);

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });

    const changed = baseMenu();
    mutate(changed);
    env.CRISP_MENU_JSON = JSON.stringify(changed);
    advance(10);

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(await receipt(db, event.eventId)).toMatchObject({
      status: 'FAILED',
      attempt_count: 2,
      last_error: 'OUTBOUND_PRECONDITION_FAILED'
    });
    expect(await outboundCount(db, 'crisp_picker:%')).toBe(0);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(0);
  });

  it('F1: keyword priority is frozen for the first event and suppresses Welcome and Picker', async () => {
    const { db, env } = setup();
    env.runtimeConfigSnapshot = {
      values: {
        CRISP_KEYWORD_RULES: JSON.stringify({
          version: 1,
          rules: [{ id: 'kw_1234567890abcdef', keyword: 'help', reply: 'keyword reply', enabled: true }]
        })
      },
      sources: { CRISP_KEYWORD_RULES: 'D1' },
      versions: { CRISP_KEYWORD_RULES: 1 },
      errors: {},
      overrideCount: 1,
      health: 'AVAILABLE'
    };
    const providers = installProviders(() => undefined);
    const event = crispEvent('crisp:keyword-first', 'message-keyword-first', 'help');

    await handleQueueEvent(event, env);

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'PROCESSED' });
    expect(await outboundCount(db, 'crisp_keyword:%')).toBe(1);
    expect(await outboundCount(db, 'crisp_welcome:%')).toBe(0);
    expect(await outboundCount(db, 'crisp_picker:%')).toBe(0);
    expect(await auditState(db, 'CRISP_BOOTSTRAP_DECISION_FIXED')).toMatchObject({ new_state: 'KEYWORD' });
    expect(providers.calls.filter(call => call.kind === 'crisp-text')).toHaveLength(1);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(0);
  });

  it('F2: operator takeover between attempts suppresses not-yet-started bootstrap sends', async () => {
    const { db, env } = setup();
    const providers = installProviders(call =>
      call.kind === 'telegram-message' && call.count === 1 ? rateLimited() : undefined
    );
    const event = crispEvent('crisp:handoff-between-attempts', 'message-handoff');

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    const conv = await conversation(db);
    await db.prepare(
      `UPDATE conversations SET ai_mode = 'PAUSED_OPERATOR', version = version + 1 WHERE id = ?`
    ).bind(conv.id).run();

    advance(10);
    await handleQueueEvent(event, env);

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 2 });
    expect(await auditState(db, 'CRISP_BOOTSTRAP_DECISION_FIXED')).toMatchObject({ new_state: 'SUPPRESSED' });
    expect(await outboundCount(db, 'crisp_welcome:%')).toBe(0);
    expect(await outboundCount(db, 'crisp_picker:%')).toBe(0);
    expect(providers.calls.filter(call => call.kind.startsWith('crisp-'))).toHaveLength(0);
  });

  it('F3: unresolved AMBIGUOUS Welcome is preserved and never resent on first-event retry', async () => {
    const { db, env } = setup();
    const providers = installProviders(call => {
      if (call.kind === 'crisp-text' && call.count === 1) throw new Error('synthetic transport ambiguity');
      return undefined;
    });
    const event = crispEvent('crisp:ambiguous-welcome-bootstrap', 'message-ambiguous-welcome');

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });
    expect(await outbound(db, 'crisp_welcome:%')).toMatchObject({
      status: 'AMBIGUOUS',
      reconciliation_status: 'PENDING'
    });

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'FAILED', attempt_count: 2 });
    expect(providers.calls.filter(call => call.kind === 'crisp-text')).toHaveLength(1);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(0);
  });

  it('F4: unresolved AMBIGUOUS Picker is preserved and never resent on first-event retry', async () => {
    const { db, env } = setup();
    const providers = installProviders(call => {
      if (call.kind === 'crisp-picker' && call.count === 1) throw new Error('synthetic transport ambiguity');
      return undefined;
    });
    const event = crispEvent('crisp:ambiguous-picker-bootstrap', 'message-ambiguous-picker');

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });
    expect(await outbound(db, 'crisp_picker:%')).toMatchObject({
      status: 'AMBIGUOUS',
      reconciliation_status: 'PENDING'
    });

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'FAILED', attempt_count: 2 });
    expect(providers.calls.filter(call => call.kind === 'crisp-text')).toHaveLength(1);
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(1);
  });

  it('preserves a Provider-confirmed Picker success as AMBIGUOUS when local SENT persistence fails', async () => {
    const { db, env } = setup();
    env.DB = withPickerSentPersistFailure(db);
    const providers = installProviders(() => undefined);
    const event = crispEvent('crisp:picker-persist-failure', 'message-picker-persist-failure');

    await expect(handleQueueEvent(event, env)).rejects.toThrow('synthetic picker result persistence failure');
    expect(await outbound(db, 'crisp_picker:%')).toMatchObject({
      status: 'SENDING',
      attempt_count: 1,
      response_http_status: 200
    });

    advance(31);
    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(await outbound(db, 'crisp_picker:%')).toMatchObject({
      status: 'AMBIGUOUS',
      attempt_count: 1,
      response_http_status: 200,
      reconciliation_status: 'PENDING'
    });
    expect(await receipt(db, event.eventId)).toMatchObject({ status: 'FAILED', attempt_count: 2 });
    expect(providers.calls.filter(call => call.kind === 'crisp-picker')).toHaveLength(1);
  });
});
