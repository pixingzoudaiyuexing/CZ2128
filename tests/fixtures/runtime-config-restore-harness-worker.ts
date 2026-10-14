import { parseCrispKeywordRules } from '../../src/config/crisp-keywords';
import { safeErrorCode } from '../../src/core/errors';
import { resolveEffectiveEnv } from '../../src/runtime-config/resolver';
import { restoreEnvOverride, setPlainOverride } from '../../src/runtime-config/service';
import { CRISP_QUIET_KEY, crispQuietMinutes } from '../../src/config/crisp-quiet';
import { recordCrispHumanReply } from '../../src/core/crisp-quiet';

interface HarnessEnv {
  DB: D1Database;
  CRISP_KEYWORD_RULES?: string;
}

interface Body {
  value?: string;
  expectedVersion?: number;
  actor?: string;
  update?: string;
  ref?: string;
  timestamp?: number;
  historyVersion?: number;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function body(request: Request): Promise<Body> {
  return request.method === 'POST' ? request.json<Body>() : {};
}

async function snapshot(env: HarnessEnv): Promise<unknown> {
  const effective = await resolveEffectiveEnv(env as any);
  const active = await env.DB.prepare(
    'SELECT key, value_kind, value_text, version, updated_by, updated_at FROM runtime_config WHERE key = ?'
  ).bind('CRISP_KEYWORD_RULES').first();
  const history = await env.DB.prepare(
    'SELECT key, version, value_kind, value_text, is_deleted, actor_user_id, action, source_update_id FROM runtime_config_history WHERE key = ? ORDER BY version'
  ).bind('CRISP_KEYWORD_RULES').all();
  const raw = effective.runtimeConfigSnapshot?.values.CRISP_KEYWORD_RULES;
  return {
    source: effective.runtimeConfigSnapshot?.sources.CRISP_KEYWORD_RULES,
    rules: parseCrispKeywordRules(raw)?.rules || null,
    active,
    history: history.results
  };
}

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health') return json({ ok: true });
    if (path === '/reset') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM crisp_human_reply_receipts'),
        env.DB.prepare("DELETE FROM conversations WHERE id = 'quiet-harness'"),
        env.DB.prepare('DELETE FROM runtime_config_history WHERE key = ?').bind(CRISP_QUIET_KEY),
        env.DB.prepare('DELETE FROM runtime_config WHERE key = ?').bind(CRISP_QUIET_KEY),
        env.DB.prepare('DELETE FROM admin_sessions'),
        env.DB.prepare("DELETE FROM runtime_config_history WHERE key = 'CRISP_KEYWORD_RULES'"),
        env.DB.prepare("DELETE FROM runtime_config WHERE key = 'CRISP_KEYWORD_RULES'")
      ]);
      return json({ ok: true });
    }
    if (path === '/snapshot') return json(await snapshot(env));
    if (path === '/quiet-snapshot') {
      const effective = await resolveEffectiveEnv(env as any);
      return json({ minutes: crispQuietMinutes(effective),
        clock: await env.DB.prepare("SELECT last_crisp_human_reply_at FROM conversations WHERE id='quiet-harness'").first(),
        receipts: (await env.DB.prepare('SELECT provider_message_ref,reply_at FROM crisp_human_reply_receipts ORDER BY provider_message_ref').all()).results,
        history: (await env.DB.prepare('SELECT version,action FROM runtime_config_history WHERE key=? ORDER BY version').bind(CRISP_QUIET_KEY).all()).results });
    }

    const input = await body(request);
    try {
      if (path === '/quiet-record') {
        await env.DB.prepare(`INSERT OR IGNORE INTO conversations
          (id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,created_at,updated_at)
          VALUES('quiet-harness','crisp','harness-site','harness-session','harness-visitor','telegram',1,1)`).run();
        await recordCrispHumanReply(env as any, 'quiet-harness', input.ref!, input.timestamp);
        return json({ ok: true });
      }
      if (path === '/quiet-set') {
        return json({ version: await setPlainOverride(env as any, CRISP_QUIET_KEY, input.value!,
          input.expectedVersion!, input.actor || 'harness', input.update!, 'SET',
          { expectedHistoryVersion: input.historyVersion }) });
      }
      if (path === '/quiet-restore') {
        return json({ version: await restoreEnvOverride(env as any, CRISP_QUIET_KEY,
          input.expectedVersion!, 'harness', input.update!) });
      }
      if (path === '/set') {
        if (typeof input.value !== 'string' || !Number.isSafeInteger(input.expectedVersion)) {
          return json({ error: 'BAD_INPUT' }, 400);
        }
        const version = await setPlainOverride(
          env as any,
          'CRISP_KEYWORD_RULES',
          input.value,
          input.expectedVersion!,
          input.actor || 'harness-admin',
          input.update || 'harness-set'
        );
        return json({ version });
      }
      if (path === '/restore') {
        if (!Number.isSafeInteger(input.expectedVersion)) return json({ error: 'BAD_INPUT' }, 400);
        const version = await restoreEnvOverride(
          env as any,
          'CRISP_KEYWORD_RULES',
          input.expectedVersion!,
          input.actor || 'harness-admin',
          input.update || 'harness-restore'
        );
        return json({ version });
      }
    } catch (error) {
      return json({ error: safeErrorCode(error) }, 409);
    }
    return json({ error: 'NOT_FOUND' }, 404);
  }
};
