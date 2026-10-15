import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processCrispEvent } from '../src/queue/crisp-handler';
import { recoverMissingLearningCandidates } from '../src/learning/repository';
import { buildAIContext } from '../src/core/ai-context';
import { getAIConfig } from '../src/config/ai';
import { SqliteD1 } from './helpers/sqlite-d1';

describe('Crisp human provenance through learning compensation', () => {
  let db: SqliteD1;
  let env: any;

  beforeEach(() => {
    db = new SqliteD1();
    db.migrateThroughHumanLearning();
    db.exec(`
      INSERT INTO conversations
        (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
         operator_channel, operator_thread_ref, created_at, updated_at)
      VALUES ('conv', 'crisp', 'site', 'session', 'visitor', 'telegram', '77', 1, 1);
      INSERT INTO messages
        (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
      VALUES ('question', 'conv', 'crisp', 'question', 'INBOUND', 'CUSTOMER', 'TEXT', 'How long does a refund take?', 1);
    `);
    env = { DB: db, QUEUE: { send: vi.fn() }, BOT_GROUP_ID: '-1001',
      TELEGRAM_BOT_TOKEN: 'synthetic-token', ATTACHMENTS_BUCKET: {}, DLQ_QUARANTINE: {} };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (!String(url).startsWith('https://api.telegram.org/')) throw new Error('Unexpected provider call');
      return Response.json({ ok: true, result: { message_id: 101 } });
    });
  });

  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  function reply(ref: string, automated: boolean, content: string) {
    return {
      version: 1 as const, source: 'crisp' as const, type: 'message_created' as const,
      eventId: `crisp:site:session:message:received:${ref}`,
      payload: { websiteRef: 'site', sessionRef: 'session', customerRef: 'visitor',
        messageRef: ref, actorRole: 'OPERATOR' as const, automated, content, providerTimestamp: Date.now() }
    };
  }

  it('never recovers automated replies as human learning or human AI context', async () => {
    await processCrispEvent(reply('automated', true, 'Automated status announcement'), env);
    expect(await recoverMissingLearningCandidates(env)).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM learning_candidates').first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT actor_role FROM messages WHERE provider_message_ref='automated'").first())
      .toEqual({ actor_role: 'SYSTEM' });

    const context = await buildAIContext(env, 'conv', getAIConfig(env));
    expect(JSON.stringify(context)).not.toContain('Automated status announcement');
    expect(context).toContainEqual({ role: 'user', content: 'How long does a refund take?' });
    const mirror = await db.prepare("SELECT request_options_json FROM outbound_operations WHERE id='send_tg_crisp_automated'").first<any>();
    expect(JSON.parse(mirror.request_options_json)).toMatchObject({
      disableNotification: true, origin: 'CRISP_AUTOMATED_OPERATOR'
    });
  });

  it('preserves genuine human capture, duplicate fencing and labeled AI context', async () => {
    const event = reply('human', false, 'Refunds take three business days.');
    await processCrispEvent(event, env);
    await processCrispEvent(event, env);
    expect(await recoverMissingLearningCandidates(env)).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM learning_candidates').first()).toEqual({ n: 1 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM learning_candidate_history').first()).toEqual({ n: 1 });
    const context = await buildAIContext(env, 'conv', getAIConfig(env));
    expect(context).toContainEqual({ role: 'system', content: 'Human operator: Refunds take three business days.' });
  });
});
