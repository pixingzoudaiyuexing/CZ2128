import { Env } from '../config/env';
import { AttachmentRow, contentDisposition, hashAttachmentToken, isSafeInlineImageMime, isValidAttachmentToken, parseSingleRange } from '../core/attachments';

export type AttachmentProxyMode = 'download' | 'inline';

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
}

function proxyHeaders(row: AttachmentRow, contentLength: number, mode: AttachmentProxyMode): Headers {
  return new Headers({
    'Content-Type': row.mime_type,
    'Content-Length': String(contentLength),
    'Content-Disposition': contentDisposition(row.safe_filename, mode === 'inline' ? 'inline' : 'attachment'),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes'
  });
}

export async function handleAttachmentProxy(
  request: Request,
  env: Env,
  token: string,
  mode: AttachmentProxyMode = 'download'
): Promise<Response> {
  if (!isValidAttachmentToken(token)) return notFound();
  const tokenHash = await hashAttachmentToken(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT * FROM attachments
     WHERE access_token_hash = ? AND expires_at > ?
       AND (
         status IN ('STORED', 'DELIVERED') OR
         (status = 'FAILED_FINAL' AND last_error = 'ATTACHMENT_DELIVERY_AMBIGUOUS')
       )`
  ).bind(tokenHash, now).first<AttachmentRow>();
  if (!row) return notFound();
  if (mode === 'inline' && !isSafeInlineImageMime(row.mime_type)) return notFound();

  let metadata: R2Object | null;
  try {
    metadata = await env.ATTACHMENTS_BUCKET.head(row.storage_key);
  } catch {
    return notFound();
  }
  if (!metadata) return notFound();

  const rangeHeader = request.headers.get('Range');
  const range = rangeHeader ? parseSingleRange(rangeHeader, metadata.size) : undefined;
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${metadata.size}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  const contentLength = range?.length ?? metadata.size;
  const headers = proxyHeaders(row, contentLength, mode);
  if (range) headers.set('Content-Range', range.contentRange);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  let object: R2ObjectBody | null;
  try {
    object = await env.ATTACHMENTS_BUCKET.get(
      row.storage_key,
      range ? { range: { offset: range.offset, length: range.length } } : undefined
    );
  } catch {
    return notFound();
  }
  if (!object) return notFound();
  return new Response(object.body, { status, headers });
}