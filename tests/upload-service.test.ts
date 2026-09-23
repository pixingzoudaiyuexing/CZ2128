import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import { createAndSendUploadInvite } from '../src/uploads/service';
import {
  deriveUploadInviteToken,
  hashUploadCapability,
  stableUploadInviteId
} from '../src/uploads/capability';

const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('upload invite durable control plane', () => {
  let db: SqliteD1;
  let env: any;
  const conversation = {
    id: 'conv',
    helpdesk_provider: 'crisp',
    helpdesk_account_ref: 'site',
    helpdesk_conversation_ref: 'session',
    operator_thread_ref: '77',
    operator_thread_status: 'OPEN'
  };

  beforeEach(async () => {
    db = new SqliteD1();
    db.migrate();
    env = {
      DB: db,
      BOT_GROUP_ID: '-100',
      TELEGRAM_BOT_TOKEN: 'bot-secret-token',
      CRISP_API_IDENTIFIER: 'crisp-id',
      CRISP_API_KEY: 'crisp-key',
      CHATWOOT_API_URL: 'https://chat.example',
      UPLOAD_CAPABILITY_SECRET: SECRET
    };
    await db.prepare(
      `INSERT INTO conversations
       (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
        operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
       VALUES ('conv', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1)`
    ).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function command(updateRef = '100') {
    return {
      supportProfileVersion: 0,
      updateRef,
      operatorRef: '42',
      publicOrigin: 'https://worker.example',
      threadRef: '77'
    };
  }

  function providerSuccessMock() {
    let crispMessage = 800;
    let telegramMessage = 900;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/state')) {
        return new Response(JSON.stringify({ data: { state: 'unresolved' } }), { status: 200 });
      }
      if (url.includes('api.crisp.chat') && url.endsWith('/message')) {
        crispMessage += 1;
        return new Response(JSON.stringify({ data: { fingerprint: crispMessage } }), { status: 200 });
      }
      if (url.includes('/sendMessage')) {
        telegramMessage += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessage } }), { status: 200 });
      }
      throw new Error('unexpected fetch ' + url);
    });
  }

  it('sends one deterministic invite link and one ack for duplicate command delivery', async () => {
    const fetchMock = providerSuccessMock();
    expect(await createAndSendUploadInvite(env, conversation, command())).toBe('SENT');
    expect(await createAndSendUploadInvite(env, conversation, command())).toBe('SENT');

    const inviteId = await stableUploadInviteId('conv', 0, '100');
    const token = await deriveUploadInviteToken(SECRET, inviteId);
    const invite = await db.prepare('SELECT * FROM upload_invites WHERE id = ?')
      .bind(inviteId).first<any>();
    expect(invite).toMatchObject({
      status: 'ACTIVE',
      created_by_operator_ref: '42',
      telegram_thread_ref: '77',
      crisp_website_ref: 'site',
      crisp_session_ref: 'session'
    });
    expect(invite.token_hash).toBe(await hashUploadCapability(token));
    expect(JSON.stringify(invite)).not.toContain(token);
    expect(JSON.stringify(invite)).not.toContain(SECRET);

    const crispPosts = fetchMock.mock.calls.filter(call =>
      String(call[0]).includes('api.crisp.chat') && String(call[0]).endsWith('/message')
    );
    const telegramPosts = fetchMock.mock.calls.filter(call => String(call[0]).includes('/sendMessage'));
    expect(crispPosts).toHaveLength(1);
    expect(telegramPosts).toHaveLength(1);
    const crispBody = JSON.parse(String(crispPosts[0][1]?.body));
    expect(crispBody.content).toContain('https://worker.example/uploads/' + token);
    expect(crispBody.content).not.toContain(SECRET);

    expect(await db.prepare(
      "SELECT status, subject_type, subject_ref, attempt_count FROM outbound_operations WHERE id = ?"
    ).bind('upload_invite_crisp:' + inviteId).first<any>()).toEqual({
      status: 'SENT',
      subject_type: 'UPLOAD_INVITE',
      subject_ref: inviteId,
      attempt_count: 1
    });
  });

  it('revokes the older invite and fences an old event arriving after a newer command', async () => {
    const fetchMock = providerSuccessMock();
    expect(await createAndSendUploadInvite(env, conversation, command('100'))).toBe('SENT');
    expect(await createAndSendUploadInvite(env, conversation, command('101'))).toBe('SENT');
    expect(await createAndSendUploadInvite(env, conversation, command('100'))).toBe('STALE');

    const oldId = await stableUploadInviteId('conv', 0, '100');
    const newId = await stableUploadInviteId('conv', 0, '101');
    expect(await db.prepare('SELECT status FROM upload_invites WHERE id = ?')
      .bind(oldId).first<any>()).toEqual({ status: 'REVOKED' });
    expect(await db.prepare('SELECT status FROM upload_invites WHERE id = ?')
      .bind(newId).first<any>()).toEqual({ status: 'ACTIVE' });

    const crispPosts = fetchMock.mock.calls.filter(call =>
      String(call[0]).includes('api.crisp.chat') && String(call[0]).endsWith('/message')
    );
    expect(crispPosts).toHaveLength(2);
  });

  it('does not create an invite when authoritative Crisp state is already resolved', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/state')) {
        return new Response(JSON.stringify({ data: { state: 'resolved' } }), { status: 200 });
      }
      if (url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }), { status: 200 });
      }
      throw new Error('unexpected visible provider call ' + url);
    });

    expect(await createAndSendUploadInvite(env, conversation, command())).toBe('FAILED_FINAL');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM upload_invites')
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(fetchMock.mock.calls.filter(call =>
      String(call[0]).includes('api.crisp.chat') && String(call[0]).endsWith('/message')
    )).toHaveLength(0);
  });

  it('fails final with zero provider attempt when state becomes resolved immediately before visible send', async () => {
    let stateReads = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/state')) {
        stateReads += 1;
        return new Response(JSON.stringify({
          data: { state: stateReads === 1 ? 'unresolved' : 'resolved' }
        }), { status: 200 });
      }
      if (url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 902 } }), { status: 200 });
      }
      throw new Error('unexpected visible provider call ' + url);
    });

    expect(await createAndSendUploadInvite(env, conversation, command())).toBe('FAILED_FINAL');
    const inviteId = await stableUploadInviteId('conv', 0, '100');
    expect(await db.prepare('SELECT status FROM upload_invites WHERE id = ?')
      .bind(inviteId).first<any>()).toEqual({ status: 'REVOKED' });
    expect(await db.prepare(
      'SELECT status, last_error, attempt_count, request_started_at FROM outbound_operations WHERE id = ?'
    ).bind('upload_invite_crisp:' + inviteId).first<any>()).toEqual({
      status: 'FAILED_FINAL',
      last_error: 'CRISP_CONVERSATION_RESOLVED',
      attempt_count: 0,
      request_started_at: null
    });
    expect(fetchMock.mock.calls.filter(call =>
      String(call[0]).includes('api.crisp.chat') && String(call[0]).endsWith('/message')
    )).toHaveLength(0);
  });

  it('fails closed rather than AMBIGUOUS when final state cannot be confirmed before request start', async () => {
    let stateReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/state')) {
        stateReads += 1;
        if (stateReads === 1) {
          return new Response(JSON.stringify({ data: { state: 'unresolved' } }), { status: 200 });
        }
        throw new Error('state network unavailable');
      }
      if (url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 903 } }), { status: 200 });
      }
      throw new Error('unexpected visible provider call ' + url);
    });

    expect(await createAndSendUploadInvite(env, conversation, command())).toBe('FAILED_FINAL');
    const inviteId = await stableUploadInviteId('conv', 0, '100');
    expect(await db.prepare(
      'SELECT status, last_error, attempt_count, request_started_at, reconciliation_status FROM outbound_operations WHERE id = ?'
    ).bind('upload_invite_crisp:' + inviteId).first<any>()).toEqual({
      status: 'FAILED_FINAL',
      last_error: 'CRISP_STATE_UNCONFIRMED_BEFORE_UPLOAD_INVITE_SEND',
      attempt_count: 0,
      request_started_at: null,
      reconciliation_status: 'NOT_REQUIRED'
    });
    expect(await db.prepare('SELECT status FROM upload_invites WHERE id = ?')
      .bind(inviteId).first<any>()).toEqual({ status: 'REVOKED' });
  });

  it('preserves an ambiguous Crisp send and never repeats the visible invite', async () => {
    let crispPosts = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/state')) {
        return new Response(JSON.stringify({ data: { state: 'unresolved' } }), { status: 200 });
      }
      if (url.includes('api.crisp.chat') && url.endsWith('/message')) {
        crispPosts += 1;
        throw new Error('response lost after request');
      }
      if (url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 904 } }), { status: 200 });
      }
      throw new Error('unexpected fetch ' + url);
    });

    expect(await createAndSendUploadInvite(env, conversation, command())).toBe('AMBIGUOUS');
    expect(await createAndSendUploadInvite(env, conversation, command())).toBe('AMBIGUOUS');
    expect(crispPosts).toBe(1);

    const inviteId = await stableUploadInviteId('conv', 0, '100');
    expect(await db.prepare('SELECT status FROM upload_invites WHERE id = ?')
      .bind(inviteId).first<any>()).toEqual({ status: 'ACTIVE' });
    expect(await db.prepare(
      'SELECT status, reconciliation_status FROM outbound_operations WHERE id = ?'
    ).bind('upload_invite_crisp:' + inviteId).first<any>()).toEqual({
      status: 'AMBIGUOUS',
      reconciliation_status: 'PENDING'
    });
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/sendMessage'))).toHaveLength(1);
  });
});
