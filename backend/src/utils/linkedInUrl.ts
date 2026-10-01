/**
 * Canonical form for a LinkedIn profile URL.
 *
 * Lives in utils/, not in unipileConnectionsDb, because it is a pure string function
 * with no storage dependency — and leadReachability needs it. Importing it from the DB
 * module dragged `AWS.config.update` into every consumer's module graph, which broke
 * suites that mock aws-sdk without a `config` key.
 */
/**
 * Normalize a LinkedIn URL to a canonical GSI key: `https://www.linkedin.com/in/<slug>/`.
 *
 * Canonicalizes scheme (http→https), www, query string and fragment so a lead URL
 * matches the cached connection key regardless of how it was entered. The sync cron
 * stores Unipile's `https://www.linkedin.com/in/<slug>/` form; before this, a lead
 * saved as `http://www.linkedin.com/in/<slug>` (or without `www.`) normalized to a
 * different key and never matched its own cached 1st-degree connection, so
 * get_lead_details reported `isConnected: false` for real connections (ENG-377).
 *
 * The trailing slash is preserved to stay byte-identical with keys already persisted
 * in AW-UnipileConnections (which were written with the trailing slash).
 */
export function normalizeLinkedInUrl(url: string): string {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return '';
  const u = trimmed
    .replace(/^https?:\/\/(?:www\.)?/, 'https://www.') // canonical scheme + www
    .split('?')[0]                                     // drop query (originalSubdomain etc.)
    .split('#')[0]                                     // drop fragment
    .replace(/\/+$/, '');                              // drop any trailing slashes
  return u + '/';
}
