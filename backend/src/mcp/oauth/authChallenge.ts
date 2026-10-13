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

export function buildMcpAuthChallenge(baseUrl: string, error?: string, resourcePath: string = MCP_RESOURCE_PATH): string {
  const params = [
    `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${resourcePath}"`,
    `scope="mcp:tools"`,
  ];
  if (error) params.push(`error="${error}"`);
  return `Bearer ${params.join(", ")}`;
}

export function getBackendUrl(): string {
  return process.env.BACKEND_URL || 'https://api.agentweb.pro';
}
