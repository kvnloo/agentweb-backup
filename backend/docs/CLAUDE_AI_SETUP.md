# Connect AgentWeb to Claude.ai

Connect Emma (AgentWeb's AI marketing assistant) to Claude.ai in under 2 minutes.

## Prerequisites

- An active AgentWeb account at [agentweb.pro](https://agentweb.pro)
- Access to [Claude.ai](https://claude.ai)

## Setup Steps

### 1. Open Claude.ai Settings

1. Go to [claude.ai](https://claude.ai)
2. Click your profile icon (bottom left)
3. Select **Settings**
4. Navigate to **Developer** tab
5. Click **Add Custom Connector**

### 2. Fill in the Connection Details

**Name:**
```
Emma
```

**URL:**
```
https://api.agentweb.pro/mcp/server
```

**Advanced Settings:**
- Leave **OAuth Client ID** blank
- Leave **OAuth Client Secret** blank

The MCP client will register automatically using OAuth 2.1 dynamic client registration.

### 3. Authorize the Connection

1. Click **Add**
2. You'll be redirected to AgentWeb's authorization page
3. Log in with your AgentWeb credentials
4. Click **Authorize** to grant Claude.ai access

### 4. Start Using Emma

Once connected, Claude.ai can access Emma's tools:

- **Blog Publishing** - Write and publish blog posts to your CMS
- **Social Media** - Create and post to LinkedIn, Meta, Instagram
- **Lead Management** - Manage your CRM and send outreach emails
- **Meta Ads** - Create and manage Facebook/Instagram ad campaigns
- **Market Research** - Run deep research reports
- **GTM Plans** - Build go-to-market strategies
- **Browser Automation** - Automate repetitive web tasks
- And many more...

**Try asking:**
- "Install all available skills"
- "Read my brand guidelines"
- "Create a blog post about [topic]"
- "List my connected LinkedIn accounts"
- "Get my Meta ad campaign performance"

## Troubleshooting

### "Connection Failed" Error

- Make sure you're logged into your AgentWeb account
- Check that your subscription is active
- Verify the URL is exactly: `https://api.agentweb.pro/mcp/server`

### "Authorization Required" Error

- Click the connector in Claude.ai settings
- Click **Reconnect** to re-authorize
- Make sure you approved the authorization request

### Can't See Tools

After connecting, run:
```
install_skills with skillIds: ["__other_skills__"]
```

This installs all available tools at once.

## Need Help?

- Full documentation: [https://api.agentweb.pro/skill.md](https://api.agentweb.pro/skill.md)
- Support: Contact us at [agentweb.pro](https://agentweb.pro)
- Discord: [Join our community](https://discord.gg/kP2u6Wf9KQ)

## For Developers

Prefer programmatic access? Generate an API key at [agentweb.pro/settings](https://agentweb.pro/settings) instead of using OAuth.
