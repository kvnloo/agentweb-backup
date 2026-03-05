# MCP Discoverability & Registry

This document tracks the implementation status of MCP discoverability features and the steps needed to list Emma on MCP registries.

## Implemented Endpoints

| Endpoint | Status | Description |
|----------|--------|-------------|
| `GET /.well-known/oauth-authorization-server` | Done | RFC 8414 metadata |
| `POST /oauth/register` | Done | RFC 7591 dynamic client registration |
| `GET /oauth/authorize` | Done | Authorization with PKCE → consent redirect |
| `POST /oauth/authorize/decision` | Done | Consent callback (creates auth code) |
| `POST /oauth/token` | Done | Token exchange (auth code + refresh) |
| `POST /mcp` | Done | MCP Streamable HTTP endpoint |
| `GET /mcp` | Done | MCP SSE stream |
| `GET /docs/agent-api` | Done | Public API documentation page |

## Auth Methods Supported

1. **API Key** (`aw_` prefix) — simple Bearer token auth
2. **OAuth 2.1** — full flow with PKCE S256, dynamic client registration
3. **Static MCP_ACCESS_TOKEN** — internal/dev use

## External TODOs

### 1. Customer Portal Consent Page

Build a React page at `/oauth/authorize` in the customer portal that:
- Receives query params: `client_id`, `client_name`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method`
- Shows the client name and requested scopes
- Has "Allow" and "Deny" buttons
- On Allow: POSTs to `POST /oauth/authorize/decision` with the user's JWT token
- On Deny: POSTs with `approved: false`

### 2. Enable DynamoDB TTL

After creating tables, run these commands to enable automatic cleanup of expired records:

```bash
# Authorization codes (10-min TTL)
aws dynamodb update-time-to-live \
  --table-name AW-MCPOAuthCodes \
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt"

# Tokens (access token 1hr, refresh token 30d)
aws dynamodb update-time-to-live \
  --table-name AW-MCPOAuthTokens \
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt"
```

For dev tables, prefix with `Dev-`.

### 3. MCP Registry Publishing (Anthropic)

Steps to list Emma on the official Anthropic MCP registry:

1. Install the publisher CLI:
   ```bash
   npm install -g @anthropic/mcp-publisher
   ```
2. Verify GitHub org ownership (AgentWebPro)
3. Publish with namespace:
   ```bash
   mcp-publisher publish --namespace io.github.AgentWebPro/agentweb
   ```
4. The registry entry should include:
   - Server URL: `https://api.agentweb.pro/mcp`
   - Auth: OAuth 2.1 discovery at `/.well-known/oauth-authorization-server`
   - Scopes: `mcp:tools`
   - Description: "Emma — AI marketing assistant with 60+ tools"

### 4. Community Registry Submissions

Submit to community registries for broader visibility:

- **mcp.so** — Submit at https://mcp.so/submit
- **glama.ai** — Submit at https://glama.ai/mcps/submit

Include:
- Name: Emma by AgentWeb
- Description: AI marketing assistant with tools for content creation, social media, lead management, ad campaigns, and more
- URL: https://api.agentweb.pro/mcp
- Auth: OAuth 2.1 + API Key
- Tool count: 60+

### 5. Custom Domain Namespace (Optional)

If preferred over GitHub org namespace, set up DNS TXT verification:

1. Add TXT record: `_mcp-verify.agentweb.pro` → `mcp-verify=<verification-token>`
2. Register namespace: `pro.agentweb/emma`
3. This allows a cleaner namespace in registries

## Dev Mode Notes

When `NODE_ENV=development`, the `/oauth/authorize` endpoint auto-approves authorization requests without showing a consent page. This is useful for local testing of the full OAuth flow without needing the customer portal consent page.
