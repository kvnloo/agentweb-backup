const MAX_HEADER_LENGTH = 20 * 1024;
const COOKIE_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

export interface ParsedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires: number;
}

/**
 * Parses a raw `Cookie:` request-header string (as copied from DevTools Network tab —
 * the one input method that reliably includes httpOnly session cookies) into
 * Playwright-compatible cookie objects for the given domain.
 */
export function parseCookieHeader(headerString: string, domain: string): ParsedCookie[] {
  if (headerString.length > MAX_HEADER_LENGTH) {
    throw new Error(`Cookie value is too large (max ${MAX_HEADER_LENGTH} bytes)`);
  }

  const trimmedHeader = headerString.trim();
  if (!trimmedHeader) {
    throw new Error('Cookie value is empty');
  }

  // A pasted value with no "=" anywhere is almost always the bare-value mistake:
  // copying a single cookie's Value column from DevTools' Application/Storage tab,
  // rather than the full "name=value; ..." string from the Network tab's cookie
  // request header. Give a guided fix instead of a generic parse error.
  if (!trimmedHeader.includes('=') && !trimmedHeader.includes(';')) {
    throw new Error(
      "This looks like you pasted just the cookie's value, not its name=value pair. " +
      'Prefix it with the cookie\'s name, e.g. "sessionid=' + trimmedHeader.slice(0, 20) + '...", ' +
      'or copy the full "cookie" request header from the Network tab instead (see the instructions above).'
    );
  }

  const normalizedDomain = '.' + domain.toLowerCase().replace(/^\.+/, '');
  const expires = Math.floor(Date.now() / 1000) + COOKIE_LIFETIME_SECONDS;

  const cookiesByName = new Map<string, ParsedCookie>();

  for (const rawSegment of trimmedHeader.split(';')) {
    const segment = rawSegment.trim();
    if (!segment) continue;

    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) {
      throw new Error(`Malformed cookie segment (missing "="): "${segment}"`);
    }

    const name = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();
    if (!name) {
      throw new Error(`Malformed cookie segment (missing name): "${segment}"`);
    }

    // Last-wins on duplicate names.
    cookiesByName.set(name, {
      name,
      value,
      domain: normalizedDomain,
      path: '/',
      secure: true,
      expires,
    });
  }

  if (cookiesByName.size === 0) {
    throw new Error('No valid cookie name=value pairs found');
  }

  return Array.from(cookiesByName.values());
}
