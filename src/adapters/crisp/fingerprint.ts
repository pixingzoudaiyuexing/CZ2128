const CRISP_FINGERPRINT_HASH_BYTES = 6;
const CRISP_FINGERPRINT_NAMESPACE = 'cz2128:crisp:fingerprint:v1:';

export async function crispFingerprintForOperation(operationId: string): Promise<number> {
  const input = new TextEncoder().encode(`${CRISP_FINGERPRINT_NAMESPACE}${operationId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  let value = 0;
  for (let index = 0; index < CRISP_FINGERPRINT_HASH_BYTES; index += 1) {
    value = (value * 256) + digest[index];
  }
  return value + 1;
}
