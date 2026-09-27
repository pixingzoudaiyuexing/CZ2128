import { describe, expect, it } from 'vitest';
import { sanitizeLearningText } from '../src/learning/privacy';

describe('learning privacy filter', () => {
  it('redacts deterministic PII, credentials and temporary capabilities before persistence', () => {
    const input = [
      'name: Alice Example',
      'alice@example.com',
      '+1 (415) 555-0199',
      'order #ABCD12345',
      'Authorization: Bearer secret-token-abcdefghijklmnop',
      '123456789:AAExampleTelegramToken_abcdefghijklmnop',
      'api_key=super-secret-value',
      'https://files.example/download?capability=temporary-secret'
    ].join(' ');
    const result = sanitizeLearningText(input);
    expect(result.text).not.toContain('alice@example.com');
    expect(result.text).not.toContain('555-0199');
    expect(result.text).not.toContain('ABCD12345');
    expect(result.text).not.toContain('secret-token-abcdefghijklmnop');
    expect(result.text).not.toContain('AAExampleTelegramToken');
    expect(result.text).not.toContain('super-secret-value');
    expect(result.text).not.toContain('temporary-secret');
    expect(result.riskLevel).toBe('HIGH');
    expect(result.flags).toEqual(expect.arrayContaining([
      'PERSON_NAME', 'EMAIL', 'PHONE', 'CUSTOMER_REFERENCE',
      'AUTHORIZATION', 'TELEGRAM_TOKEN', 'CREDENTIAL', 'TEMPORARY_URL'
    ]));
  });

  it('keeps ordinary reusable support text usable', () => {
    const result = sanitizeLearningText('Refunds are normally processed within three business days.');
    expect(result).toEqual({
      text: 'Refunds are normally processed within three business days.',
      riskLevel: 'LOW',
      flags: []
    });
  });

  it('bounds long text without making it a credential risk', () => {
    const result = sanitizeLearningText('A'.repeat(13000));
    expect(Array.from(result.text)).toHaveLength(12000);
    expect(result.flags).toContain('TRUNCATED');
    expect(result.riskLevel).toBe('MEDIUM');
  });
});

