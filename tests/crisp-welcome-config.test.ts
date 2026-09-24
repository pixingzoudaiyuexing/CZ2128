import { describe, expect, it } from 'vitest';
import {
  createCrispWelcomeConfig,
  parseCrispWelcomeConfig,
  resolveCrispWelcome
} from '../src/config/crisp-welcome';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { restoreEnvOverride, setPlainOverride } from '../src/runtime-config/service';
import { RuntimeConfigConflictError } from '../src/runtime-config/repository';
import { RuntimeDb, masterKey } from './helpers/runtime-db';

function env(db = new RuntimeDb()) {
  return {
    DB: db,
    RUNTIME_CONFIG_MASTER_KEY: masterKey(),
    CRISP_WELCOME_TEXT: 'ENV welcome',
    AI_REQUEST_TIMEOUT_MS: '30000',
    AI_GENERATION_LEASE_SECONDS: '60'
  } as any;
}

describe('Crisp welcome runtime config', () => {
  it('treats a missing ENV value as unconfigured instead of inventing a default', async () => {
    const testEnv = env();
    delete testEnv.CRISP_WELCOME_TEXT;
    const effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({ status: 'UNCONFIGURED', source: 'NONE' });
  });

  it('explicitly disabled D1 config suppresses ENV fallback while preserving selected text', async () => {
    const testEnv = env();
    await setPlainOverride(
      testEnv,
      'CRISP_WELCOME_CONFIG',
      createCrispWelcomeConfig('Selected welcome', false),
      0,
      '1001',
      '1'
    );
    const effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({
      status: 'DISABLED',
      text: 'Selected welcome',
      source: 'D1'
    });
    expect(effective.CRISP_WELCOME_TEXT).toBe('ENV welcome');
  });

  it('re-enables the same selected text and uses CAS', async () => {
    const testEnv = env();
    await setPlainOverride(
      testEnv,
      'CRISP_WELCOME_CONFIG',
      createCrispWelcomeConfig('Selected welcome', false),
      0,
      '1001',
      '2'
    );
    await expect(setPlainOverride(
      testEnv,
      'CRISP_WELCOME_CONFIG',
      createCrispWelcomeConfig('Selected welcome', true),
      1,
      '1001',
      '3'
    )).resolves.toBe(2);
    await expect(setPlainOverride(
      testEnv,
      'CRISP_WELCOME_CONFIG',
      createCrispWelcomeConfig('wrong stale update', true),
      1,
      '1002',
      '4'
    )).rejects.toBeInstanceOf(RuntimeConfigConflictError);
    expect(resolveCrispWelcome(await resolveEffectiveEnv(testEnv))).toEqual({
      status: 'ENABLED',
      text: 'Selected welcome',
      source: 'D1'
    });
  });

  it('restores the original ENV fallback after removing the D1 override', async () => {
    const testEnv = env();
    await setPlainOverride(
      testEnv,
      'CRISP_WELCOME_CONFIG',
      createCrispWelcomeConfig('Runtime welcome', false),
      0,
      '1001',
      '5'
    );
    await restoreEnvOverride(testEnv, 'CRISP_WELCOME_CONFIG', 1, '1001', '6');
    const effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({
      status: 'ENABLED',
      text: 'ENV welcome',
      source: 'ENV'
    });
  });

  it('fails closed when the D1 welcome payload is invalid', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push({
      key: 'CRISP_WELCOME_CONFIG',
      value_kind: 'PLAIN',
      value_text: '{"version":1,"enabled":true,"text":""}',
      ciphertext: null,
      nonce: null,
      version: 1,
      updated_by: '1001',
      updated_at: 1
    });
    const effective = await resolveEffectiveEnv(testEnv);
    expect(effective.runtimeConfigSnapshot?.errors.CRISP_WELCOME_CONFIG).toBe('RUNTIME_CONFIG_VALUE_INVALID');
    expect(resolveCrispWelcome(effective)).toEqual({ status: 'ERROR', source: 'D1' });
  });

  it('bounds and canonicalizes welcome text', () => {
    expect(parseCrispWelcomeConfig(createCrispWelcomeConfig('  Hello  ', true))).toEqual({
      version: 1,
      enabled: true,
      text: 'Hello'
    });
    expect(() => createCrispWelcomeConfig('')).toThrow('RUNTIME_CONFIG_VALUE_INVALID');
  });
});
