/**
 * RFC 9728 `WWW-Authenticate` challenge shared by every OAuth-protected MCP resource.
 *
 * `resource_metadata` points at the path-specific protected-resource metadata document
 * (`/.well-known/oauth-protected-resource<resourcePath>`), whose `resource` field must equal
 * the URL the client connected to. MCP clients (Claude Code, Codex) reject metadata whose
 * resource does not match, so each resource gets its own document.
 */
export const MCP_RESOURCE_PATH = '/mcp';
export const META_TOOLKIT_MCP_RESOURCE_PATH = '/api/meta-toolkit/mcp';

/**
 * Append an attribution `ref` (ENG-2906) as the only query parameter. Callers pass a value
 * already validated against /^[a-z0-9_-]{1,64}$/; it is still URI-encoded so no caller can ever
 * break out of the quoted challenge parameter.
 */
export function withRef(url: string, ref: string | undefined): string {
  return ref ? `${url}?ref=${encodeURIComponent(ref)}` : url;
}

export function buildMcpAuthChallenge(baseUrl: string, error?: string, resourcePath: string = MCP_RESOURCE_PATH, ref?: string): string {
  const params = [
    `resource_metadata="${withRef(`${baseUrl}/.well-known/oauth-protected-resource${resourcePath}`, ref)}"`,
    `scope="mcp:tools"`,
  ];
  if (error) params.push(`error="${error}"`);
  return `Bearer ${params.join(", ")}`;
}

export function getBackendUrl(): string {
  return process.env.BACKEND_URL || 'https://api.agentweb.pro';
}
