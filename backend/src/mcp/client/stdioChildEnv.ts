/**
 * ENG-3187: environment for stdio MCP child processes.
 *
 * Children used to start with `{ ...process.env, ...resolvedEnv }`, i.e. a full copy of the
 * backend's environment (JWT_SECRET, AWS keys, Stripe/Slack tokens, ...). A customer-driven
 * MCP server (Playwright's browser_run_code) could read it. A child now gets only what a
 * process needs to run — PATH, HOME, locale, temp dir, proxy/CA settings — plus the
 * variables its own server config declares (`resolvedEnv`), which is the only way a secret
 * should reach a child.
 */
export const STDIO_CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'PLAYWRIGHT_BROWSERS_PATH', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  // Windows equivalents, for local dev.
  'SystemRoot', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
];
export const ALLOWED_PREFIXES: readonly string[] = ['LC_', 'XDG_'];

export function buildStdioChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  resolvedEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (STDIO_CHILD_ENV_ALLOWLIST.includes(key) || ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
      env[key] = value;
    }
  }
  return { ...env, ...resolvedEnv };
}
