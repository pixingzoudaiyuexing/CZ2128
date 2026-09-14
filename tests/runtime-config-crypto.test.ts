import { describe, expect, it } from 'vitest';
import { decryptRuntimeSecret, encryptRuntimeSecret, validateMasterKey } from '../src/runtime-config/crypto';
import { masterKey } from './helpers/runtime-db';

describe('runtime config AES-GCM', () => {
  it('encrypts with a fresh 12-byte nonce and decrypts with a 256-bit key', async () => {
    const encrypted = await encryptRuntimeSecret(masterKey(), 'AI_API_KEY', 'private-secret');
    expect(encrypted.ciphertext).not.toContain('private-secret');
    expect(encrypted.nonce).toHaveLength(16);
    await expect(decryptRuntimeSecret(masterKey(), 'AI_API_KEY', encrypted.ciphertext, encrypted.nonce))
      .resolves.toBe('private-secret');
  });

  it('rejects invalid and wrong master keys', async () => {
    expect(() => validateMasterKey('short')).toThrow('RUNTIME_CONFIG_MASTER_KEY_INVALID');
    const encrypted = await encryptRuntimeSecret(masterKey(), 'AI_API_KEY', 'secret');
    await expect(decryptRuntimeSecret(masterKey(8), 'AI_API_KEY', encrypted.ciphertext, encrypted.nonce))
      .rejects.toThrow('RUNTIME_CONFIG_SECRET_DECRYPT_FAILED');
  });

  it.each(['ciphertext', 'nonce'] as const)('rejects modified %s', async field => {
    const encrypted = await encryptRuntimeSecret(masterKey(), 'AI_API_KEY', 'secret');
    encrypted[field] = `${encrypted[field].startsWith('A') ? 'B' : 'A'}${encrypted[field].slice(1)}`;
    await expect(decryptRuntimeSecret(masterKey(), 'AI_API_KEY', encrypted.ciphertext, encrypted.nonce))
      .rejects.toThrow('RUNTIME_CONFIG_SECRET_DECRYPT_FAILED');
  });

  it('binds ciphertext to its config key through AAD', async () => {
    const encrypted = await encryptRuntimeSecret(masterKey(), 'AI_API_KEY', 'secret');
    await expect(decryptRuntimeSecret(masterKey(), 'CHATWOOT_API_TOKEN', encrypted.ciphertext, encrypted.nonce))
      .rejects.toThrow('RUNTIME_CONFIG_SECRET_DECRYPT_FAILED');
  });

  it('rejects a modified AES-GCM authentication tag', async () => {
    const encrypted = await encryptRuntimeSecret(masterKey(), 'AI_API_KEY', 'secret');
    const padding = '='.repeat((4 - encrypted.ciphertext.length % 4) % 4);
    const binary = atob(encrypted.ciphertext.replace(/-/g, '+').replace(/_/g, '/') + padding);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    bytes[bytes.length - 1] ^= 1;
    let modified = '';
    for (const byte of bytes) modified += String.fromCharCode(byte);
    const ciphertext = btoa(modified).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(decryptRuntimeSecret(masterKey(), 'AI_API_KEY', ciphertext, encrypted.nonce))
      .rejects.toThrow('RUNTIME_CONFIG_SECRET_DECRYPT_FAILED');
  });
});
