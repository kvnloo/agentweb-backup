# Connecting to Emma by AgentWeb

Emma is an AI marketing assistant by AgentWeb with 60+ tools for content creation, social media, lead management, ad campaigns, and more. External agents can connect to Emma and use her tools via the MCP protocol or REST API.

## How to Connect (3 Steps)

### Step 1: Sign up at AgentWeb

Go to [https://app.agentweb.pro](https://app.agentweb.pro) and create an account. You'll need an active subscription to generate API keys.

If you don't have a subscription yet, go to Settings → API Keys and click "Subscribe to Get API Access" to complete checkout.

### Step 2: Create an API Key

1. Log into the customer portal at [https://app.agentweb.pro](https://app.agentweb.pro)
2. Go to **Settings** → **API Keys** tab
3. Click **Create API Key**, give it a name (e.g. "My Agent")
4. **Copy the key immediately** — it starts with `aw_` and is only shown once

### Step 3: Connect Your Agent

#### For MCP-compatible agents (Claude Code, OpenClaw, etc.)

Add this to your MCP configuration (`.mcp.json`, `mcp_config.json`, or equivalent):

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

Replace `aw_YOUR_KEY_HERE` with your actual API key from Step 2.

Restart your agent after adding the config. Emma's tools will appear as MCP tools (e.g. `mcp__emma__create_blog_article`).

#### For Claude Code specifically

Add the config above to either:
- `~/.claude/mcp.json` (available in all projects)
- `.mcp.json` in your project root (project-specific)

Then restart Claude Code. You can verify the connection by asking Claude to list Emma's tools.

#### For REST API / custom integrations

If your agent doesn't support MCP, use the REST API directly:

```bash
# List available tools
curl https://api.agentweb.pro/api/v1/agent/tools \
  -H "Authorization: Bearer aw_YOUR_KEY_HERE"

# Execute a tool
curl -X POST https://api.agentweb.pro/api/v1/agent/tools/execute \
  -H "Authorization: Bearer aw_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"toolName": "create_blog_article", "args": {"topic": "AI Agents"}}'
```

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

### Access Brand Knowledge
- **Brand guidelines** — Read and update your brand documentation
- **Market strategy** — Access your saved market analysis and positioning

> To see every available tool with its exact parameters, call the tool discovery endpoint or ask your agent to list Emma's MCP tools after connecting.

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

**Connection refused / timeout** — Make sure you're using the correct URL (`https://api.agentweb.pro/mcp/server` for MCP, `https://api.agentweb.pro/api/v1/agent/` for REST).

**401 or 403 errors** — Your API key may be invalid, revoked, or expired. Create a new one from Settings → API Keys.

**429 Too Many Requests** — You've hit the rate limit (60/min). Wait a moment and retry. The response includes a `retryAfterMs` field.

**Tools not showing up in Claude Code** — Make sure you restarted Claude Code after adding the MCP config. Check that the JSON is valid and the key is correct.

---

## Links

- **Customer Portal:** [https://app.agentweb.pro](https://app.agentweb.pro)
- **API Base URL:** `https://api.agentweb.pro`
- **MCP Endpoint:** `https://api.agentweb.pro/mcp/server`
- **REST Tool Discovery:** `GET https://api.agentweb.pro/api/v1/agent/tools`
