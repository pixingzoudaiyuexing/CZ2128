import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerNotificationMode } from '../src/config/telegram-customer-ux';
import { normalizeCrispEvent } from '../src/index';

const NOW = 1792000000;

describe('independent Crisp human notification window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it('silences customer notifications during the window even after AI has resumed', () => {
    expect(customerNotificationMode({} as any, {
      ai_mode: 'ENABLED', last_crisp_human_reply_at: NOW - 899
    } as any)).toBe('silent');
  });

  it('restores normal notification exactly at 15 minutes while AI remains paused', () => {
    expect(customerNotificationMode({ TELEGRAM_NOTIFY_CRISP_OPERATOR: 'silent' } as any, {
      ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'CRISP_OPERATOR',
      last_crisp_human_reply_at: NOW - 900
    } as any)).toBe('normal');
  });

  it('does not give old Crisp pause rows a permanent quiet window', () => {
    expect(customerNotificationMode({} as any, {
      ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'CRISP_OPERATOR',
      last_crisp_human_reply_at: null
    } as any)).toBe('normal');
  });

  it('keeps the active window after a Telegram operator changes AI pause provenance', () => {
    expect(customerNotificationMode({} as any, {
      ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'TELEGRAM_OPERATOR',
      last_crisp_human_reply_at: NOW - 30
    } as any)).toBe('silent');
  });

  it('uses the independent minute setting rather than the AI auto-resume timeout', () => {
    const env = { TELEGRAM_CRISP_HUMAN_QUIET_MINUTES: '1', AI_OPERATOR_PAUSE_TIMEOUT_SECONDS: '86400' } as any;
    expect(customerNotificationMode(env, {
      ai_mode: 'ENABLED', last_crisp_human_reply_at: NOW - 59
    } as any)).toBe('silent');
    expect(customerNotificationMode(env, {
      ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'CRISP_OPERATOR',
      last_crisp_human_reply_at: NOW - 60
    } as any)).toBe('normal');
  });

  it('preserves manual-off policy after the Crisp window expires', () => {
    const conversation = {
      ai_mode: 'PAUSED_MANUAL', ai_pause_source: 'MANUAL',
      last_crisp_human_reply_at: NOW - 901
    } as any;
    expect(customerNotificationMode({} as any, conversation)).toBe('silent');
    expect(customerNotificationMode({ TELEGRAM_NOTIFY_MANUAL_OFF: 'normal' } as any, conversation)).toBe('normal');
  });

  it('ignores future or damaged quiet anchors rather than creating an unbounded window', () => {
    for (const anchor of [NOW + 1, NaN, Infinity, -1]) {
      expect(customerNotificationMode({} as any, {
        ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'CRISP_OPERATOR',
        last_crisp_human_reply_at: anchor
      } as any)).toBe('normal');
    }
  });

  it('preserves original Crisp message time instead of fresh webhook delivery time', () => {
    const original = (NOW - 3600) * 1000;
    const event = normalizeCrispEvent({
      event: 'message:received', timestamp: NOW * 1000,
      data: {
        website_id: 'website-a', session_id: 'session-a', fingerprint: 501,
        type: 'text', from: 'operator', automated: false, content: 'A historical human reply',
        timestamp: original
      }
    }, 'historical-operator', 'website-a');
    expect(event).toMatchObject({ payload: { providerTimestamp: original } });
  });
});
