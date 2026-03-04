# Connecting to Emma by AgentWeb

Emma is an AI marketing assistant by AgentWeb with 60+ tools for content creation, social media, lead management, ad campaigns, and more. External agents can connect to Emma and use her tools via the MCP protocol.

## How to Connect

There are two ways to authenticate: **API Key** (simple, recommended for personal use) and **OAuth 2.1** (for published MCP clients and apps that connect on behalf of users).

---

### Option A: API Key (Recommended)

#### Step 1: Sign up at AgentWeb

Go to [https://app.agentweb.pro](https://app.agentweb.pro) and create an account. You'll need an active subscription to generate API keys.

If you don't have a subscription yet, go to Settings → API Keys and click "Subscribe to Get API Access" to complete checkout.

#### Step 2: Create an API Key

1. Log into the customer portal at [https://app.agentweb.pro](https://app.agentweb.pro)
2. Go to **Settings** → **API Keys** tab
3. Click **Create API Key**, give it a name (e.g. "My Agent")
4. **Copy the key immediately** — it starts with `aw_` and is only shown once

#### Step 3: Connect Your Agent via MCP

Add Emma to your MCP client's configuration using the examples below.

**Claude Code** (`.mcp.json` or `~/.claude/mcp.json`):
```json
{
  "mcpServers": {
    "emma": {
      "type": "streamable-http",
      "url": "https://api.agentweb.pro/mcp/server",
      "headers": {
        "Authorization": "Bearer aw_YOUR_KEY_HERE"
      }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "emma": {
      "transport": "streamable-http",
      "url": "https://api.agentweb.pro/mcp/server",
      "headers": {
        "Authorization": "Bearer aw_YOUR_KEY_HERE"
      }
    }
  }
}
```

**Cursor** (Settings → MCP → Add Server):
```json
{
  "mcpServers": {
    "emma": {
      "url": "https://api.agentweb.pro/mcp/server",
      "headers": {
        "Authorization": "Bearer aw_YOUR_KEY_HERE"
      }
    }
  }
}
```

**VS Code (Continue)** (`.continue/config.json`):
```json
{
  "mcpServers": [
    {
      "name": "emma",
      "transport": {
        "type": "streamable-http",
        "url": "https://api.agentweb.pro/mcp/server",
        "headers": {
          "Authorization": "Bearer aw_YOUR_KEY_HERE"
        }
      }
    }
  ]
}
```

**Windsurf** (MCP config):
```json
{
  "mcpServers": {
    "emma": {
      "serverUrl": "https://api.agentweb.pro/mcp/server",
      "headers": {
        "Authorization": "Bearer aw_YOUR_KEY_HERE"
      }
    }
  }
}
```

Replace `aw_YOUR_KEY_HERE` with your actual API key from Step 2. Restart your agent after adding the config.

---

### Option B: OAuth 2.1

For MCP clients that support OAuth 2.1 (per the MCP authorization spec), Emma supports the full OAuth 2.1 flow with PKCE.

#### Discovery

Your MCP client can auto-discover Emma's OAuth configuration:

```
GET https://api.agentweb.pro/.well-known/oauth-authorization-server
```

This returns RFC 8414 metadata including all endpoint URLs, supported grant types, and scopes.

#### OAuth Flow Summary

1. **Register your client** (one-time): `POST /oauth/register` with your `redirect_uris` and `client_name`
2. **Authorize**: Redirect the user to `GET /oauth/authorize` with PKCE challenge — they'll see a consent page
3. **Exchange code for tokens**: `POST /oauth/token` with the authorization code and PKCE verifier
4. **Use the access token**: Include `Authorization: Bearer <access_token>` on MCP requests to `/mcp/server`
5. **Refresh when expired**: `POST /oauth/token` with `grant_type=refresh_token`

#### OAuth Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata discovery |
| `/oauth/register` | POST | Dynamic client registration (RFC 7591) |
| `/oauth/authorize` | GET | Authorization endpoint (redirects to consent) |
| `/oauth/authorize/decision` | POST | Consent callback (creates auth code) |
| `/oauth/token` | POST | Token exchange and refresh |

#### Scopes

| Scope | Description |
|-------|-------------|
| `mcp:tools` | Access to all Emma MCP tools |

#### Token Lifetimes

- **Access token**: 1 hour
- **Refresh token**: 30 days
- **Authorization code**: 10 minutes (single-use)

#### PKCE Requirement

PKCE with S256 is **mandatory** for all authorization requests. The `plain` method is not supported.

---

## What Can Emma Do?

Once connected, your agent has access to 60+ tools across these categories:

### Write Content
- **Blog posts** — SEO-optimized articles on any topic
- **Social media posts** — LinkedIn, Twitter/X, Instagram content
- **Books** — Outlines, chapters, and full long-form content
- **Email templates** — HTML email creation and template management

### Manage Social Media
- **Post to LinkedIn, Meta, Instagram** — Publish directly to connected accounts
- **Engage on LinkedIn** — Comment on posts, react to content
- **View analytics** — Post performance and engagement metrics

### Run Marketing Campaigns
- **Meta Ads** — Create and manage Facebook/Instagram ad campaigns
- **GTM Plans** — Build and track go-to-market strategies
- **Market Research** — Deep research on markets, competitors, and trends

### Manage Leads
- **Find and filter leads** — Search by criteria, create segments
- **Send emails** — Outreach to leads with personalized emails
- **Track engagement** — Monitor email opens, clicks, and responses

### Automate Tasks
- **Browser automation** — Create tasks that automate web workflows
- **Work plans** — Multi-step project plans with progress tracking
- **Image & video generation** — AI-powered visual content creation

### Manage Portal Resources
- **Tasks** — Create, update, delete, and execute automation tasks
- **Schedules** — Set up recurring task schedules (daily/weekly/monthly)

### Access Brand Knowledge
- **Brand guidelines** — Read and update your brand documentation
- **Market strategy** — Access your saved market analysis and positioning

> To see every available tool with its exact parameters, ask your agent to list Emma's MCP tools after connecting.

---

## Managing Your API Keys

- **Create keys:** Settings → API Keys → Create API Key
- **View keys:** Settings → API Keys (shows name, masked key, creation date, last used)
- **Revoke keys:** Click the trash icon next to any key — access is revoked immediately
- Keys never expire by default, but you can revoke them anytime
- Each key has a rate limit of 60 requests per minute

---

## Troubleshooting

**"Active subscription required"** — You need to complete Stripe checkout before creating API keys. Go to Settings → API Keys and click the subscribe button.

**Connection refused / timeout** — Make sure you're using the correct URL (`https://api.agentweb.pro/mcp/server` for MCP).

**401 or 403 errors** — Your API key may be invalid, revoked, or expired. Create a new one from Settings → API Keys.

**429 Too Many Requests** — You've hit the rate limit (60/min). Wait a moment and retry. The response includes a `retryAfterMs` field.

**Tools not showing up in Claude Code** — Make sure you restarted Claude Code after adding the MCP config. Check that the JSON is valid and the key is correct.

---

## Links

- **Customer Portal:** [https://app.agentweb.pro](https://app.agentweb.pro)
- **API Base URL:** `https://api.agentweb.pro`
- **MCP Endpoint:** `https://api.agentweb.pro/mcp/server`
