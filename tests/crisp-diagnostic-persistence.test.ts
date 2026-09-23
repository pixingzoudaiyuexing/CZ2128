import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrispMessage, createCrispPicker } from '../src/adapters/crisp/api';

interface AuditCapture {
  sql: string;
  args: unknown[];
}

function diagnosticEnv(captures: AuditCapture[], failWrite = false): any {
  return {
    CRISP_API_IDENTIFIER: 'identifier',
    CRISP_API_KEY: 'key',
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            captures.push({ sql, args });
            return {
              async run() {
                if (failWrite) throw new Error('diagnostic write failed');
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
    }
  };
}

describe('Crisp durable HTTP 400 diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('persists only whitelisted invalid_data metadata for a text send', async () => {
    const captures: AuditCapture[] = [];
    const env = diagnosticEnv(captures);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: true,
      reason: 'invalid_data',
      data: { message: 'private@example.com token-SECRET session-SECRET' }
    }), { status: 400 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(createCrispMessage(env, 'website-1', 'session-1', 'private reply', 'op-400'))
      .rejects.toMatchObject({
        outcome: 'FINAL',
        code: 'OUTBOUND_PROVIDER_4XX_FINAL',
        provider: 'CRISP',
        httpStatus: 400
      });

    expect(captures).toHaveLength(1);
    expect(captures[0].args).toEqual([
      'crisp-http400-diagnostic:v1:op-400',
      'OUTBOUND_OPERATION',
      'op-400',
      'CRISP_HTTP_400_DIAGNOSTIC',
      'SYSTEM',
      'system:crisp-adapter',
      'HTTP_400',
      'text:JSON_OBJECT:ERROR_TRUE',
      'invalid_data',
      expect.any(Number)
    ]);
    const persisted = JSON.stringify(captures[0]);
    expect(persisted).not.toContain('private@example.com');
    expect(persisted).not.toContain('token-SECRET');
    expect(persisted).not.toContain('session-SECRET');
    expect(persisted).not.toContain('private reply');
    expect(persisted).not.toContain('session-1');
  });

  it('persists UNKNOWN_PROVIDER_REASON without arbitrary provider text', async () => {
    const captures: AuditCapture[] = [];
    const env = diagnosticEnv(captures);
    const privateReason = 'invalid for private@example.com token-SECRET';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: true, reason: privateReason }), { status: 400 })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(createCrispPicker(env, 'website-1', 'session-1', 'main', 'Choose', [
      { value: 'human', label: 'Contact human' }
    ], 'picker-op-400')).rejects.toMatchObject({
      outcome: 'FINAL',
      code: 'OUTBOUND_PROVIDER_4XX_FINAL',
      httpStatus: 400
    });

    expect(captures).toHaveLength(1);
    expect(captures[0].args[7]).toBe('picker:JSON_OBJECT:ERROR_TRUE');
    expect(captures[0].args[8]).toBe('UNKNOWN_PROVIDER_REASON');
    expect(JSON.stringify(captures[0])).not.toContain(privateReason);
    expect(JSON.stringify(captures[0])).not.toContain('Contact human');
  });

  it('persists the whitelisted invalid_session reason', async () => {
    const captures: AuditCapture[] = [];
    const env = diagnosticEnv(captures);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: true, reason: 'invalid_session' }), { status: 400 })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(createCrispMessage(env, 'website-1', 'session-1', 'Reply', 'session-op-400'))
      .rejects.toMatchObject({ outcome: 'FINAL', code: 'OUTBOUND_PROVIDER_4XX_FINAL', httpStatus: 400 });

    expect(captures).toHaveLength(1);
    expect(captures[0].args[7]).toBe('text:JSON_OBJECT:ERROR_TRUE');
    expect(captures[0].args[8]).toBe('invalid_session');
  });

  it.each([
    ['', 'EMPTY'],
    ['{bad-json', 'NON_JSON'],
    ['x'.repeat(5000), 'TOO_LARGE']
  ])('durably classifies bounded diagnostic body state %s', async (responseBody, expectedState) => {
    const captures: AuditCapture[] = [];
    const env = diagnosticEnv(captures);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseBody, { status: 400 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(createCrispMessage(env, 'website-1', 'session-1', 'Reply', 'body-state-400'))
      .rejects.toMatchObject({ outcome: 'FINAL', code: 'OUTBOUND_PROVIDER_4XX_FINAL', httpStatus: 400 });

    expect(captures).toHaveLength(1);
    expect(captures[0].args[7]).toBe(`text:${expectedState}:ERROR_UNKNOWN`);
    expect(captures[0].args[8]).toBe('UNKNOWN_PROVIDER_REASON');
    if (responseBody) expect(JSON.stringify(captures[0])).not.toContain(responseBody.slice(0, 64));
  });

  it('keeps HTTP 400 final when durable diagnostic persistence fails', async () => {
    const captures: AuditCapture[] = [];
    const env = diagnosticEnv(captures, true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: true, reason: 'invalid_data' }), { status: 400 })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(createCrispMessage(env, 'website-1', 'session-1', 'Reply', 'd1-fail-400'))
      .rejects.toMatchObject({
        outcome: 'FINAL',
        code: 'OUTBOUND_PROVIDER_4XX_FINAL',
        provider: 'CRISP',
        httpStatus: 400
      });
    expect(captures).toHaveLength(1);
  });

  it('does not persist a diagnostic for successful or non-400 responses', async () => {
    const captures: AuditCapture[] = [];
    const env = diagnosticEnv(captures);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { fingerprint: 9 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: true, reason: 'private' }), { status: 429 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(createCrispMessage(env, 'website-1', 'session-1', 'Reply', 'ok-op'))
      .resolves.toEqual({ messageId: '9' });
    await expect(createCrispMessage(env, 'website-1', 'session-1', 'Reply', 'rate-op'))
      .rejects.toMatchObject({ outcome: 'RETRYABLE', code: 'OUTBOUND_RATE_LIMITED', httpStatus: 429 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captures).toHaveLength(0);
  });
});
