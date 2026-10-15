import { Env } from './env';

// Deployment-owned origin; webhook/request hosts and queued input never authorize links.
export function trustedPublicOrigin(env: Env): string {
  const value = env.PUBLIC_ORIGIN?.trim() || '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || url.origin !== value || url.hostname.endsWith('.workers.dev')) throw new Error();
    return url.origin;
  } catch { throw new Error('UPLOAD_PUBLIC_ORIGIN_INVALID'); }
}
