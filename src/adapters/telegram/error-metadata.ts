const MAX_TELEGRAM_ERROR_METADATA_BYTES = 4096;
export const MAX_TELEGRAM_ERROR_METADATA_READ_MS = 1000;

const METADATA_READ_TIMEOUT = Symbol('TELEGRAM_ERROR_METADATA_READ_TIMEOUT');

export function telegramRetryAfterValue(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return undefined;
  const parameters = (payload as { parameters?: unknown }).parameters;
  if (!parameters || typeof parameters !== 'object') return undefined;
  return (parameters as { retry_after?: unknown }).retry_after;
}

export async function readTelegramRetryAfterMetadata(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof METADATA_READ_TIMEOUT>(resolve => {
    timeout = setTimeout(() => resolve(METADATA_READ_TIMEOUT), MAX_TELEGRAM_ERROR_METADATA_READ_MS);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === METADATA_READ_TIMEOUT) {
        void reader.cancel('TELEGRAM_ERROR_METADATA_READ_TIMEOUT').catch(() => undefined);
        return undefined;
      }
      const { done, value } = next;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TELEGRAM_ERROR_METADATA_BYTES) {
        void reader.cancel('TELEGRAM_ERROR_METADATA_TOO_LARGE').catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    try { reader.releaseLock(); } catch { /* cancellation may still be settling */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return telegramRetryAfterValue(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}
