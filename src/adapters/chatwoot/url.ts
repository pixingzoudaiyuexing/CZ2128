export function canonicalChatwootBaseUrl(rawBaseUrl: string): string {
  const url = new URL(rawBaseUrl);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Chatwoot base URL');
  }
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${basePath}`;
}

export function buildChatwootApiUrl(
  rawBaseUrl: string,
  apiPath: string,
  query?: URLSearchParams
): string {
  if (!apiPath.startsWith('/') || apiPath.startsWith('//')) {
    throw new Error('Invalid Chatwoot API path');
  }
  const suffix = query && query.size > 0 ? `?${query.toString()}` : '';
  return `${canonicalChatwootBaseUrl(rawBaseUrl)}${apiPath}${suffix}`;
}
