import { RuntimeConfigKey } from './types';

export interface EncryptedValue {
  ciphertext: string;
  nonce: string;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('RUNTIME_CONFIG_INVALID_ENCODING');
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

export function validateMasterKey(value: string | undefined): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('RUNTIME_CONFIG_MASTER_KEY_INVALID');
  }
  const decoded = decodeBase64Url(value);
  if (decoded.byteLength !== 32) throw new Error('RUNTIME_CONFIG_MASTER_KEY_INVALID');
  return decoded;
}

async function importMasterKey(masterKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asArrayBuffer(validateMasterKey(masterKey)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(key: RuntimeConfigKey): Uint8Array {
  return new TextEncoder().encode(`cz2128:runtime-config:${key}`);
}

export async function encryptRuntimeSecret(
  masterKey: string,
  key: RuntimeConfigKey,
  plaintext: string
): Promise<EncryptedValue> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad(key)), tagLength: 128 },
    await importMasterKey(masterKey),
    new TextEncoder().encode(plaintext)
  );
  return { ciphertext: encodeBase64Url(new Uint8Array(encrypted)), nonce: encodeBase64Url(nonce) };
}

export async function decryptRuntimeSecret(
  masterKey: string,
  key: RuntimeConfigKey,
  ciphertext: string,
  nonceValue: string
): Promise<string> {
  const nonce = decodeBase64Url(nonceValue);
  if (nonce.byteLength !== 12) throw new Error('RUNTIME_CONFIG_SECRET_DECRYPT_FAILED');
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad(key)), tagLength: 128 },
      await importMasterKey(masterKey),
      asArrayBuffer(decodeBase64Url(ciphertext))
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new Error('RUNTIME_CONFIG_SECRET_DECRYPT_FAILED');
  }
}

export function generateOpaqueSecret(bytes = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
