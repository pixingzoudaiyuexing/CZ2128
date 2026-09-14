const MAX_TELEGRAM_ERROR_METADATA_BYTES = 4096;

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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TELEGRAM_ERROR_METADATA_BYTES) {
        await reader.cancel('TELEGRAM_ERROR_METADATA_TOO_LARGE');
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
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
