import { parseCrispKeywordRules } from '../../src/config/crisp-keywords';
import { safeErrorCode } from '../../src/core/errors';
import { resolveEffectiveEnv } from '../../src/runtime-config/resolver';
import { restoreEnvOverride, setPlainOverride } from '../../src/runtime-config/service';

interface HarnessEnv {
  DB: D1Database;
  CRISP_KEYWORD_RULES?: string;
}

interface Body {
  value?: string;
  expectedVersion?: number;
  actor?: string;
  update?: string;
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
        env.DB.prepare('DELETE FROM admin_sessions'),
        env.DB.prepare("DELETE FROM runtime_config_history WHERE key = 'CRISP_KEYWORD_RULES'"),
        env.DB.prepare("DELETE FROM runtime_config WHERE key = 'CRISP_KEYWORD_RULES'")
      ]);
      return json({ ok: true });
    }
    if (path === '/snapshot') return json(await snapshot(env));

    const input = await body(request);
    try {
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
