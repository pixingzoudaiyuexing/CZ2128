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
    ,'Content-Security-Policy': "default-src 'none'; sandbox"
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
         (transfer_version=2 AND stored_at IS NOT NULL) OR status IN ('STORED', 'DELIVERED') OR
         (status = 'FAILED_FINAL' AND last_error = 'ATTACHMENT_DELIVERY_AMBIGUOUS')
       )`
  ).bind(tokenHash, now).first<AttachmentRow>();
  const granted = row || await env.DB.prepare(
    `SELECT a.* FROM attachment_access_grants g JOIN attachments a ON a.id=g.attachment_id
     WHERE g.token_hash=? AND g.expires_at>? AND g.revoked_at IS NULL
       AND COALESCE(a.retention_expires_at,a.expires_at)>? AND a.deleted_at IS NULL
       AND ((a.transfer_version=2 AND a.stored_at IS NOT NULL) OR a.status IN ('STORED','DELIVERED') OR
         (a.status='FAILED_FINAL' AND a.last_error='ATTACHMENT_DELIVERY_AMBIGUOUS'))`
  ).bind(tokenHash, now, now).first<AttachmentRow>();
  if (!granted || granted.deleted_at || granted.grant_revoked_at ||
      (granted.retention_expires_at ?? granted.expires_at ?? 0) <= now ||
      (granted.grant_expires_at != null && granted.grant_expires_at <= now)) return notFound();
  if (mode === 'inline' && (!isSafeInlineImageMime(granted.mime_type) ||
      granted.transfer_version === 2 && granted.retention_class !== 'IMAGE')) return notFound();

  let metadata: R2Object | null;
  try {
    metadata = await env.ATTACHMENTS_BUCKET.head(granted.storage_key);
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
  const headers = proxyHeaders(granted, contentLength, mode);
  if (range) headers.set('Content-Range', range.contentRange);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  let object: R2ObjectBody | null;
  try {
    object = await env.ATTACHMENTS_BUCKET.get(
      granted.storage_key,
      range ? { range: { offset: range.offset, length: range.length } } : undefined
    );
  } catch {
    return notFound();
  }
  if (!object) return notFound();
  return new Response(object.body, { status, headers });
}
