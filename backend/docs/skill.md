# Emma by AgentWeb — Complete Tool Reference

Emma is your AI-powered GTM (Go-To-Market) automation specialist. She connects to your business systems—CMS, CRM, social media, ad platforms—and executes marketing workflows autonomously.

This guide is designed for **AI agents** connecting via Model Context Protocol (MCP). It provides deep context on every tool: what it does, when to use it, how to chain workflows, and how to handle edge cases.

---

## Table of Contents

1. [Authentication](#authentication)
2. [Tool Organization](#tool-organization)
3. [Decision Trees](#decision-trees)
4. [Tool Catalog (by Domain)](#tool-catalog)
5. [Complete Workflows](#complete-workflows)
6. [Best Practices](#best-practices)

---

## Authentication

**Endpoint:** `https://api.agentweb.pro/mcp`
**Transport:** Streamable HTTP (MCP 2024-11-05)
**Auth:** OAuth browser sign-in from your MCP client, or API-key bearer auth

**Claude.ai / Claude Desktop / Claude account connector:**
1. Open Claude settings > Connectors.
2. Add a custom web connector.
3. Use remote MCP server URL `https://api.agentweb.pro/mcp`.
4. Click Connect and complete AgentWeb OAuth.

This account-level connector is the preferred Claude path when you want the same Emma connection available across Claude surfaces.

**Claude Code:**
```bash
claude mcp add --scope user --transport http emma https://api.agentweb.pro/mcp
claude mcp list
```

The first Emma tool call opens the AgentWeb consent flow. After approval, the MCP client stores and refreshes OAuth tokens automatically. If you already connected Emma from claude.ai as an account-level connector, enable that connector in Claude Code rather than creating a duplicate direct connection.

**Codex:**
Add this to `~/.codex/config.toml`:
```toml
[mcp_servers.emma]
url = "https://api.agentweb.pro/mcp"
```

Then authenticate:
```bash
codex mcp login emma
codex mcp list
```

**API-Key Fallback:**
1. Log in at `https://start.agentweb.pro`
2. Navigate to Settings > API Keys
3. Generate an MCP access token (starts with `aw_`)

**Manual MCP Client Configuration:**
```json
{
  "mcpServers": {
    "emma": {
      "type": "streamable-http",
      "url": "https://api.agentweb.pro/mcp",
      "headers": {
        "Authorization": "Bearer aw_YOUR_KEY_HERE"
      }
    }
  }
}
```

**Session Behavior:**
- Sessions auto-expire after 1 hour of inactivity
- All tools are available immediately (no skill installation required)
- Tool execution is synchronous except for browser automation tasks

---

## Tool Organization

Emma exposes **92 tools** across 10 domains:

| Domain | Tools | Purpose |
|--------|-------|---------|
| **Brand & Strategy** | 4 | Brand voice, market positioning, ICP management |
| **Content Creation** | 12 | Blog posts, books, social media, HTML templates |
| **CRM & Leads** | 20 | Lead management, email campaigns, engagement tracking |
| **Social Media** | 8 | LinkedIn, Meta, posting, commenting, analytics |
| **Ads Management** | 4 | Meta Ads (Facebook/Instagram) campaigns and insights |
| **GTM Planning** | 12 | Go-to-market plans, phases, work items, reporting |
| **Media Generation** | 5 | AI image/video creation, image analysis |
| **Research** | 4 | Web search, deep research, data analysis |
| **Knowledge Base** | 6 | Document storage, search, file management |
| **Automation** | 17 | Browser tasks, work plans, review workflows |

**All tools are available from the start.** Choose the right tool based on the task—descriptions below guide proper usage.

---

## Decision Trees

### "Which lead tool should I use?"

```
What are you trying to do?
│
├─ **List ALL leads in a specific list** (simple browse/search)
│  └─→ Use: get_leads
│       - Supports optional text search across all fields
│       - Returns paginated results
│       - Best for: "Show me all leads" or "Find leads containing 'director'"
│
├─ **Search with PRECISE field-level filters** (structured queries)
│  └─→ Use: search_leads
│       - Filter by specific fields (company, title, ICP score, dealValue, etc.)
│       - Uses AND logic (all filters must match)
│       - Best for: "Find leads at Fortune 500 companies with Director+ titles"
│
├─ **Get details for ONE specific lead** (by ID or email)
│  └─→ Use: get_lead_details
│       - Returns full lead record with all custom fields
│       - Includes engagement history
│       - Best for: "Show me everything about lead@example.com"
│
└─ **Create a new empty lead list**
   └─→ Use: create_lead_list
```

### "Which blog tool should I use?"

```
What stage are you at?
│
├─ **Starting from scratch** (no content yet)
│  └─→ Use: create_blog_article
│       - Generates AI content + images + HTML
│       - Uses brand voice and SEO best practices
│       - Returns HTML file URL for review
│
├─ **Ready to publish** (content reviewed and approved)
│  └─→ Use: publish_blog_article
│       - Publishes to CMS (BaseHub or Webflow)
│       - Sets categories, author, publish date
│       - Returns published article URL
│
└─ **Need to fix image issues** (images broken or need optimization)
   └─→ Use: repair_blog_article
        - Re-optimizes images in existing article
        - Useful after image generation failures
```

### "Which task creation tool should I use?"

```
What kind of automation do you need?
│
├─ **Browser automation** (web scraping, form filling, clicking)
│  ├─ From a template → create_task_from_template
│  └─ From scratch → create_task_from_prompt
│
├─ **Image generation task** (AI image creation)
│  └─→ Use: create_image_task_from_prompt
│
├─ **Recurring task** (daily/weekly/monthly schedule)
│  └─→ Use: portal_create_schedule
│
└─ **One-time manual task** (execute immediately)
   └─→ Use: portal_execute_task
```

### "Which social media tool should I use?"

```
What do you want to do?
│
├─ **See which accounts are connected**
│  └─→ Use: list_connected_accounts
│
├─ **Create post content** (draft copy, no publish)
│  └─→ Use: create_social_media_posts
│
├─ **Publish to account** (LinkedIn, Meta, Twitter, etc.)
│  └─→ Use: post_on_connected_account
│
├─ **Engage with LinkedIn content**
│  ├─ Comment → comment_on_linkedin_post
│  └─ React (like, celebrate, etc.) → react_to_linkedin_post
│
└─ **Check performance**
   ├─ Specific post → get_post_analytics
   └─ Account overview → load_connected_account_metrics
```

---

## Tool Catalog

### 1. Brand & Strategy Tools

#### `read_brand_guidelines`

**What it does:** Retrieves the user's complete brand identity and style guide.

**Returns:**
- Brand name, tagline, mission
- Color palette (primary, secondary, gradients)
- Typography (font families)
- Brand voice, tone, personality
- Target audience
- Founder profiles (name, role, writing style)
- Logo and asset URLs

**When to use:**
- BEFORE creating any content (blogs, social posts, emails, ads)
- To ensure content matches brand voice
- To get correct colors/fonts for visual content

**Prerequisites:** User must have configured brand guidelines in their account (otherwise returns `exists: false`)

**Example:**
```javascript
read_brand_guidelines()
// Returns brand data object with all fields
```

**Related tools:**
- `update_brand_guidelines` — Modify brand data
- `read_market_strategy` — Get business context

---

#### `update_brand_guidelines`

**What it does:** Updates the user's brand guidelines. Can update brand data (colors, fonts, voice) and/or brand assets (logos, brand guides).

**IMPORTANT:** Always call `read_brand_guidelines` FIRST to fetch existing data, then update only the fields that need to change. Sending partial data will NOT merge—it replaces the entire field.

**Parameters:**
- `brandData` — Object with fields to update (brandName, tagline, primaryColor, toneOfVoice, etc.)
- `brandAssets` — Array of asset objects with `type`, `url`, `filename`

**Asset types:**
- `logo` — Primary logo
- `secondaryLogo` — Alternative logo
- `brandGuide` — PDF/document brand style guide
- `additionalAsset` — Other brand collateral

**SVG WARNING:** Do NOT upload SVG files for logos. Convert to PNG or JPG first.

**Example:**
```javascript
// 1. Read existing brand data
const existingBrand = read_brand_guidelines();

// 2. Update only what changed
update_brand_guidelines({
  brandData: {
    ...existingBrand.brandData,
    tagline: "New tagline here",
    primaryColor: "#FF5733"
  }
});
```

**Related tools:**
- `read_brand_guidelines` — Get current brand data

---

#### `read_market_strategy`

**What it does:** Retrieves the user's business strategy, competitive landscape, and ideal customer profiles (ICPs).

**Returns:**
- Business overview (mission, vision, value prop)
- Target markets and segments
- Competitor analysis (names, positioning, strengths/weaknesses)
- Ideal Customer Profiles (ICPs):
  - Company size, industry, location
  - Job titles, pain points, goals
  - Buying behavior, decision criteria

**When to use:**
- BEFORE creating content for a specific audience
- To understand competitive positioning
- To score leads against ICP criteria
- For GTM planning and messaging

**Prerequisites:** User must have configured market strategy (otherwise returns `exists: false`)

**Example:**
```javascript
read_market_strategy()
// Returns strategy object with business, competitors, ICPs
```

**Related tools:**
- `update_market_strategy` — Modify strategy
- `read_brand_guidelines` — Get brand voice

---

#### `update_market_strategy`

**What it does:** Updates business overview, competitor list, and/or ICP definitions.

**IMPORTANT:** Like brand guidelines, always read first, then update only changed fields.

**Parameters:**
- `businessOverview` — Object with mission, vision, value prop, target markets
- `competitors` — Array of competitor objects (name, website, positioning, strengths, weaknesses)
- `idealCustomerProfiles` — Array of ICP objects (company criteria, persona details, pain points)

**Example:**
```javascript
update_market_strategy({
  competitors: [
    {
      name: "Competitor X",
      website: "https://competitorx.com",
      positioning: "Enterprise automation platform",
      strengths: ["Large market share", "Strong brand"],
      weaknesses: ["High price", "Complex setup"]
    }
  ]
});
```

**Related tools:**
- `read_market_strategy` — Get current strategy

---

### 2. Content Creation Tools

#### `create_blog_article`

**What it does:** Generates a complete, SEO-optimized blog article from scratch using AI. Includes:
- AI-written content (based on topic, brand voice, target audience)
- Hero image (AI-generated or sourced)
- HTML file with embedded styles
- Meta tags (title, description, keywords)
- Upload to S3 for review

**When to use:** Starting a new blog post from scratch.

**Prerequisites:**
- Brand guidelines should be configured (uses brand voice)
- Market strategy should be configured (targets correct audience)

**Parameters:**
- `topic` — The main subject (e.g., "AI automation for enterprise SaaS")
- `keywords` — Optional SEO keywords to target
- `tone` — Optional override for brand tone (casual, professional, technical, etc.)
- `targetAudience` — Optional audience override (defaults to brand's target audience)
- `imagePrompt` — Optional custom prompt for hero image generation

**Returns:**
- `htmlFileUrl` — S3 URL to generated HTML file
- `title` — Generated article title
- `description` — Meta description
- `heroImageUrl` — URL to generated hero image
- `wordCount` — Total word count

**Example:**
```javascript
create_blog_article({
  topic: "How to automate your GTM workflows with AI",
  keywords: ["GTM automation", "AI marketing", "workflow automation"],
  tone: "professional but approachable"
})
```

**Workflow chain:**
1. `read_brand_guidelines` → get voice/tone
2. `read_market_strategy` → get target audience
3. `perform_deep_research` → (optional) research topic
4. **THIS TOOL** → generate article
5. Review HTML file
6. `publish_blog_article` → publish to CMS

**Related tools:**
- `publish_blog_article` — Publish generated article
- `repair_blog_article` — Fix image issues
- `perform_deep_research` — Research topic before writing

---

#### `publish_blog_article`

**What it does:** Publishes a finalized blog article to the user's CMS (BaseHub or Webflow).

**When to use:** After creating and reviewing a blog article, ready to go live.

**Prerequisites:**
- User must have CMS configured (BaseHub or Webflow)
- Article HTML must be generated (from `create_blog_article`)

**Parameters:**
- `title` — Article title
- `description` — Meta description
- `content` — Article content (markdown or HTML)
- `imageUrl` — Hero image URL
- `imageFilename` — Image filename
- `htmlReportUrl` — (Optional) URL to full HTML report
- `executionId` — (Optional) Task execution ID for tracking

**Returns:**
- `success` — Boolean
- `message` — Status message
- `published URL` — Live article URL (if successful)

**Example:**
```javascript
publish_blog_article({
  title: "How to Automate Your GTM Workflows",
  description: "Learn how AI can streamline your go-to-market operations...",
  content: "# Introduction\n\nIn today's fast-paced...",
  imageUrl: "https://s3.amazonaws.com/hero-image.jpg",
  imageFilename: "hero-image.jpg"
})
```

**Workflow chain:**
1. `create_blog_article` → generate article
2. Review and approve content
3. **THIS TOOL** → publish to CMS
4. `create_social_media_posts` → create promo posts
5. `post_on_connected_account` → promote on social

**Related tools:**
- `create_blog_article` — Generate article first
- `list_cms_categories` — Get available categories
- `repair_blog_article` — Fix issues post-publish

---

#### `repair_blog_article`

**What it does:** Repairs a blog article by re-optimizing images. Useful when:
- Image generation failed during initial creation
- Images aren't displaying correctly
- Need to regenerate hero image with new prompt

**When to use:** After publishing, if images are broken or need updates.

**Parameters:**
- `htmlFileUrl` — URL to the article HTML file
- `newImagePrompt` — (Optional) New prompt for hero image regeneration

**Returns:**
- `success` — Boolean
- `repairedHtmlUrl` — URL to repaired HTML file
- `newImageUrl` — URL to newly generated image (if applicable)

**Example:**
```javascript
repair_blog_article({
  htmlFileUrl: "https://s3.amazonaws.com/article-xyz.html",
  newImagePrompt: "A futuristic dashboard showing AI-powered automation"
})
```

**Related tools:**
- `create_blog_article` — Original article creation
- `publish_blog_article` — Republish after repair

---

#### `list_cms_categories`

**What it does:** Lists available categories/tags in the user's CMS for blog publishing.

**When to use:** Before publishing a blog article, to select the correct category.

**Returns:** Array of category objects with `id`, `name`, `slug`

**Example:**
```javascript
list_cms_categories()
// Returns: [{ id: "cat-123", name: "AI & Automation", slug: "ai-automation" }, ...]
```

**Related tools:**
- `publish_blog_article` — Use category ID when publishing

---

#### `create_social_media_posts`

**What it does:** Generates social media post content (copy only, no publish) optimized for multiple platforms.

**When to use:** Need to create post drafts for LinkedIn, Twitter, Facebook, etc.

**Parameters:**
- `topic` — Post subject
- `platforms` — Array of platforms (e.g., `["linkedin", "twitter", "facebook"]`)
- `tone` — Optional tone override (defaults to brand voice)
- `includeHashtags` — Boolean (default: true)
- `includeEmojis` — Boolean (default: true)
- `callToAction` — Optional CTA text

**Returns:** Array of post objects, one per platform:
- `platform` — Platform name
- `content` — Post copy
- `hashtags` — Array of suggested hashtags
- `characterCount` — Total length

**Example:**
```javascript
create_social_media_posts({
  topic: "New AI automation feature launch",
  platforms: ["linkedin", "twitter"],
  tone: "excited but professional",
  callToAction: "Try it free at start.agentweb.pro"
})
```

**Workflow chain:**
1. `read_brand_guidelines` → get brand voice
2. **THIS TOOL** → generate post drafts
3. Review and approve
4. `post_on_connected_account` → publish each post

**Related tools:**
- `post_on_connected_account` — Publish generated posts
- `list_connected_accounts` — Check which accounts are available

---

### 3. CRM & Lead Management Tools

#### `get_leads` vs `search_leads` — **CRITICAL DISTINCTION**

##### `get_leads`

**What it does:** Lists ALL leads from a specific list with optional simple text search.

**When to use:**
- Browsing/paginating through a lead list
- Simple text search across all fields
- Don't need structured filtering

**Parameters:**
- `list_id` — Lead list ID (required)
- `search` — (Optional) Text to search for (searches across email, name, company, title)
- `limit` — (Optional) Results per page (default: 20, max: 100)
- `offset` — (Optional) Pagination offset

**Returns:** Array of lead objects with basic fields + pagination metadata

**Example:**
```javascript
// List all leads in a list
get_leads({ list_id: "list-123" })

// Simple text search
get_leads({
  list_id: "list-123",
  search: "director",  // Finds "director" anywhere in email, name, company, or title
  limit: 50
})
```

**When NOT to use:** If you need precise field-level filtering (company=X AND title=Y), use `search_leads` instead.

---

##### `search_leads`

**What it does:** Searches leads using structured field-level filters with AND logic.

**When to use:**
- Precise filtering on specific fields
- Multiple filter criteria (all must match)
- Advanced queries like "ICP score > 80" or "dealValue > $50k"

**Parameters:**
- `list_id` — Lead list ID (required)
- `filters` — Array of filter objects (all use AND logic)
  - `field` — Field name (email, firstName, lastName, company, title, phone, icpScore, dealValue, or custom fields)
  - `operator` — Comparison operator:
    - `equals` — Exact match
    - `contains` — Substring match
    - `starts_with` — Prefix match
    - `greater_than` — Numeric/date comparison
    - `less_than` — Numeric/date comparison
    - `not_equals` — Exclusion
    - `is_empty` — Field is null/empty
    - `is_not_empty` — Field has a value
  - `value` — Comparison value (not needed for is_empty/is_not_empty)
- `limit` — (Optional) Max results (default: 20, max: 50)

**Returns:** Array of leads matching ALL filters

**Example:**
```javascript
// Find high-value leads at enterprise companies
search_leads({
  list_id: "list-123",
  filters: [
    { field: "company", operator: "contains", value: "Corp" },
    { field: "title", operator: "contains", value: "Director" },
    { field: "icpScore", operator: "greater_than", value: 80 },
    { field: "dealValue", operator: "greater_than", value: 50000 }
  ],
  limit: 20
})

// Find leads missing phone numbers
search_leads({
  list_id: "list-123",
  filters: [
    { field: "phone", operator: "is_empty" }
  ]
})
```

**When NOT to use:** If you just need a simple text search or want to list all leads, use `get_leads` instead (simpler and faster).

---

#### `get_lead_details`

**What it does:** Retrieves the complete record for a single lead, including all custom fields and engagement history.

**When to use:**
- Need full details for one specific lead
- Reviewing lead before outreach
- Checking engagement history

**Parameters:**
- `leadId` — Lead ID (required)
- OR
- `email` — Lead email (alternative lookup)

**Returns:** Full lead object with:
- All standard fields (email, name, company, title, phone, etc.)
- All custom fields
- Engagement history (emails sent, opens, clicks, replies)
- Lead score and status

**Example:**
```javascript
get_lead_details({ leadId: "lead-123" })
// OR
get_lead_details({ email: "cto@example.com" })
```

**Related tools:**
- `get_lead_engagements` — Get detailed engagement history
- `update_lead` — Update lead fields
- `send_email_to_lead` — Send outreach email

---

#### `create_lead_list`

**What it does:** Creates a new empty lead list for organizing leads.

**When to use:** Starting a new campaign, segment, or outreach sequence.

**Parameters:**
- `name` — List name (required, e.g., "Q1 Enterprise Outreach")
- `description` — (Optional) List description

**Returns:**
- `listId` — Newly created list ID
- `name` — List name
- `createdAt` — Timestamp

**Example:**
```javascript
create_lead_list({
  name: "Q1 2026 Enterprise Outreach",
  description: "Director+ titles at Fortune 500 companies"
})
```

**Workflow chain:**
1. **THIS TOOL** → create list
2. `add_leads_to_list` → import leads
3. `configure_lead_statuses` → set up custom statuses
4. `get_leads` → review imported leads
5. `send_email_to_lead` → start outreach

**Related tools:**
- `add_leads_to_list` — Add leads to new list
- `get_lead_lists` — List all lists

---

#### `add_leads_to_list`

**What it does:** Imports leads into an existing list. Can import from:
- CSV file (upload URL)
- Array of lead objects
- Another lead list (copy/move)

**Parameters:**
- `list_id` — Target list ID
- `leads` — Array of lead objects with fields:
  - `email` — (Required) Lead email
  - `firstName`, `lastName`, `company`, `title`, `phone` — Standard fields
  - Any custom fields defined in your account
- OR
- `csvUrl` — URL to CSV file with lead data

**Returns:**
- `success` — Boolean
- `imported` — Count of successfully imported leads
- `failed` — Count of failed imports
- `errors` — Array of error messages (if any)

**Example:**
```javascript
add_leads_to_list({
  list_id: "list-123",
  leads: [
    {
      email: "cto@example.com",
      firstName: "Jane",
      lastName: "Doe",
      company: "Example Corp",
      title: "Chief Technology Officer",
      phone: "+1-555-0100"
    },
    {
      email: "ceo@startup.com",
      firstName: "John",
      lastName: "Smith",
      company: "Startup Inc",
      title: "CEO"
    }
  ]
})
```

**Related tools:**
- `create_lead_list` — Create list first
- `get_leads` — Review imported leads

---

#### `update_lead`

**What it does:** Updates one or more fields for a specific lead.

**Parameters:**
- `leadId` — Lead ID (required)
- `updates` — Object with fields to update (any standard or custom field)

**Example:**
```javascript
update_lead({
  leadId: "lead-123",
  updates: {
    title: "VP of Engineering",
    phone: "+1-555-0200",
    customField_industry: "SaaS"
  }
})
```

**Related tools:**
- `get_lead_details` — Get current lead data
- `update_lead_status` — Update status specifically

---

#### `update_lead_status`

**What it does:** Changes a lead's status in your CRM pipeline.

**Parameters:**
- `leadId` — Lead ID
- `status` — New status value (must match configured statuses for the list)

**Example:**
```javascript
update_lead_status({
  leadId: "lead-123",
  status: "Qualified"
})
```

**Related tools:**
- `get_lead_list_statuses` — Check available statuses
- `configure_lead_statuses` — Set up custom statuses

---

#### `send_email_to_lead`

**What it does:** Sends a personalized email to a lead. Tracks opens, clicks, and replies automatically.

**Prerequisites:** User must have email/SMTP configured in their account.

**Parameters:**
- `leadId` — Lead ID
- `subject` — Email subject line
- `body` — Email body (HTML or plain text)
- `fromName` — (Optional) Sender name
- `replyTo` — (Optional) Reply-to email address

**Email tracking:** Automatically embeds tracking pixels for opens and rewrites links for click tracking.

**Returns:**
- `success` — Boolean
- `messageId` — Email message ID for tracking
- `sentAt` — Timestamp

**Example:**
```javascript
send_email_to_lead({
  leadId: "lead-123",
  subject: "Quick question about your automation needs",
  body: `
    Hi {{firstName}},

    I noticed your team at {{company}} is scaling quickly...

    Best,
    John
  `,
  fromName: "John from AgentWeb"
})
```

**Template variables available:**
- `{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{title}}`
- Any custom field: `{{customField_name}}`

**Workflow chain:**
1. `get_lead_details` → get lead data for personalization
2. `update_email_draft_for_lead` → (optional) customize email
3. **THIS TOOL** → send email
4. `get_lead_engagements` → track opens/clicks
5. `add_lead_engagement` → log replies/meetings
6. `update_lead_status` → move to next stage

**Related tools:**
- `update_email_draft_for_lead` — Customize email before sending
- `get_lead_engagements` — Track email performance
- `get_task_subscriber_engagement_events` — Get detailed engagement events

---

### 4. Social Media Tools

#### `list_connected_accounts`

**What it does:** Lists all social media and ad accounts connected via OAuth.

**Returns:** Array of account objects with:
- `accountId` — Unique account ID
- `platform` — Platform name (linkedin, meta, twitter, etc.)
- `accountName` — Display name
- `accountType` — Type (personal, business, ad_account, page)
- `status` — Connection status (active, expired, error)
- `permissions` — Array of granted permissions

**Example:**
```javascript
list_connected_accounts()
// Returns:
[
  {
    accountId: "acc-123",
    platform: "linkedin",
    accountName: "John Doe",
    accountType: "personal",
    status: "active",
    permissions: ["post", "comment", "analytics"]
  },
  {
    accountId: "acc-456",
    platform: "meta",
    accountName: "AgentWeb Business Page",
    accountType: "page",
    status: "active",
    permissions: ["post", "ads", "insights"]
  }
]
```

**When to use:** Before posting or running ads, to check which accounts are available.

**Related tools:**
- `post_on_connected_account` — Post to an account
- `load_connected_account_metrics` — Get account analytics

---

#### `post_on_connected_account`

**What it does:** Publishes content to a connected social media account (LinkedIn, Meta, Twitter, etc.).

**Prerequisites:** Account must be connected (check with `list_connected_accounts`)

**Parameters:**
- `accountId` — Account ID from `list_connected_accounts`
- `content` — Post text/copy
- `mediaUrls` — (Optional) Array of image/video URLs to attach
- `linkUrl` — (Optional) Link to include (for link previews)
- `scheduledTime` — (Optional) ISO 8601 timestamp for scheduled post

**Returns:**
- `success` — Boolean
- `postId` — Platform-specific post ID
- `postUrl` — Direct URL to published post (if available)

**Example:**
```javascript
post_on_connected_account({
  accountId: "acc-123",
  content: `🚀 Excited to announce our new AI automation feature!

Transform your GTM workflows with intelligent automation.

Try it free: https://start.agentweb.pro

#AI #Automation #GTM`,
  mediaUrls: ["https://s3.amazonaws.com/feature-screenshot.jpg"],
  scheduledTime: "2026-03-10T14:00:00Z"
})
```

**Platform-specific notes:**
- **LinkedIn:** Supports text, images, videos, and link previews. Max 3,000 characters.
- **Meta (Facebook/Instagram):** Supports text, images, and videos. Max 63,206 characters (but shorter is better).
- **Twitter:** Max 280 characters. Images and videos supported.

**Workflow chain:**
1. `read_brand_guidelines` → get brand voice
2. `create_social_media_posts` → generate post drafts
3. `list_connected_accounts` → find target account
4. **THIS TOOL** → publish post
5. `get_post_analytics` → monitor performance

**Related tools:**
- `create_social_media_posts` — Generate post content
- `list_connected_accounts` — Check available accounts
- `get_post_analytics` — Track post performance

---

#### `comment_on_linkedin_post`

**What it does:** Posts a comment on a LinkedIn post (personal or company page).

**Prerequisites:** LinkedIn account must be connected with comment permissions.

**Parameters:**
- `accountId` — Your connected LinkedIn account ID
- `postUrl` — URL of the LinkedIn post to comment on (e.g., `https://www.linkedin.com/feed/update/urn:li:activity:1234567890`)
- `comment` — Comment text (max 1,250 characters)

**Returns:**
- `success` — Boolean
- `commentId` — LinkedIn comment ID

**Example:**
```javascript
comment_on_linkedin_post({
  accountId: "acc-123",
  postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7890123456",
  comment: "Great insights! We've seen similar trends in AI adoption..."
})
```

**Use cases:**
- Engage with target accounts
- Build thought leadership
- Respond to mentions
- Support partner content

**Related tools:**
- `react_to_linkedin_post` — Like/celebrate a post
- `list_connected_accounts` — Check LinkedIn accounts

---

#### `react_to_linkedin_post`

**What it does:** Adds a reaction (like, celebrate, support, love, insightful, curious) to a LinkedIn post.

**Parameters:**
- `accountId` — Your connected LinkedIn account ID
- `postUrl` — URL of the LinkedIn post
- `reactionType` — Reaction type:
  - `like` — Standard like
  - `celebrate` — 🎉 Celebrate
  - `support` — 💪 Support
  - `love` — ❤️ Love
  - `insightful` — 💡 Insightful
  - `curious` — 🤔 Curious

**Example:**
```javascript
react_to_linkedin_post({
  accountId: "acc-123",
  postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7890123456",
  reactionType: "insightful"
})
```

**Related tools:**
- `comment_on_linkedin_post` — Add a comment

---

#### `get_post_analytics`

**What it does:** Retrieves detailed performance metrics for a specific social media post.

**Parameters:**
- `accountId` — Account ID
- `postId` — Post ID (from `post_on_connected_account` response)

**Returns:**
- `impressions` — Total views
- `engagement` — Total interactions (likes, comments, shares)
- `clicks` — Link clicks
- `shares` — Share count
- `comments` — Comment count
- `reactions` — Breakdown by reaction type (LinkedIn)

**Example:**
```javascript
get_post_analytics({
  accountId: "acc-123",
  postId: "post-xyz"
})
```

**Related tools:**
- `load_connected_account_metrics` — Account-level metrics
- `post_on_connected_account` — Create post

---

#### `load_connected_account_metrics`

**What it does:** Loads aggregate analytics for a connected social media account.

**Parameters:**
- `accountId` — Account ID
- `startDate` — (Optional) Start date (ISO 8601)
- `endDate` — (Optional) End date (ISO 8601)

**Returns:**
- `followerCount` — Total followers
- `impressions` — Total impressions in date range
- `engagement` — Total engagement
- `topPosts` — Array of best-performing posts
- `engagementRate` — Average engagement rate

**Example:**
```javascript
load_connected_account_metrics({
  accountId: "acc-123",
  startDate: "2026-02-01T00:00:00Z",
  endDate: "2026-03-01T00:00:00Z"
})
```

**Related tools:**
- `get_post_analytics` — Post-level metrics

---

### 5. Meta Ads Management Tools

#### `call_meta_marketing_api`

**What it does:** Full CRUD access to the Meta Marketing API for managing Facebook/Instagram ads. Supports:
- Campaigns (create, read, update, delete)
- Ad Sets (budget, targeting, schedule)
- Ads (creative, copy, CTA)
- Ad Creatives (images, videos, carousels)
- Custom Audiences (targeting)
- Targeting Specs (interests, demographics, behaviors)
- Pages (linked Facebook pages)

**When to use:** Building/managing Meta ad campaigns programmatically.

**Prerequisites:** Meta ad account must be connected with ads_management permissions.

**Parameters:**
- `operation` — Operation type:
  - `CREATE` — Create new entity
  - `READ` — Get entity details
  - `UPDATE` — Modify entity
  - `DELETE` — Remove entity
  - `UPLOAD_IMAGE` — Upload image for creatives
- `entityType` — Entity type:
  - `campaign`, `adset`, `ad`, `adcreative`, `audience`, `targeting`, `page`
- `accountId` — Ad account ID (from `list_connected_accounts`)
- `entityId` — (For READ/UPDATE/DELETE) Entity ID
- `data` — (For CREATE/UPDATE) Entity data object

**Example — Create Campaign:**
```javascript
call_meta_marketing_api({
  operation: "CREATE",
  entityType: "campaign",
  accountId: "act_123456",
  data: {
    name: "Q1 Lead Gen Campaign",
    objective: "OUTCOME_LEADS",
    status: "PAUSED",
    special_ad_categories: []
  }
})
```

**Example — Upload Image:**
```javascript
call_meta_marketing_api({
  operation: "UPLOAD_IMAGE",
  entityType: "adimage",
  accountId: "act_123456",
  data: {
    imageUrl: "https://s3.amazonaws.com/ad-creative.jpg"
  }
})
// Returns: { image_hash: "abc123..." }
```

**Example — Create Ad:**
```javascript
// 1. Create campaign
const campaign = call_meta_marketing_api({ operation: "CREATE", entityType: "campaign", ... });

// 2. Create ad set
const adSet = call_meta_marketing_api({
  operation: "CREATE",
  entityType: "adset",
  data: {
    name: "Ad Set 1",
    campaign_id: campaign.id,
    daily_budget: 5000, // cents
    billing_event: "IMPRESSIONS",
    optimization_goal: "LEAD_GENERATION",
    targeting: {
      geo_locations: { countries: ["US"] },
      age_min: 25,
      age_max: 65
    },
    start_time: "2026-03-10T00:00:00Z"
  }
});

// 3. Upload image
const image = call_meta_marketing_api({
  operation: "UPLOAD_IMAGE",
  data: { imageUrl: "https://..." }
});

// 4. Create creative
const creative = call_meta_marketing_api({
  operation: "CREATE",
  entityType: "adcreative",
  data: {
    name: "Creative 1",
    object_story_spec: {
      page_id: "page-123",
      link_data: {
        image_hash: image.image_hash,
        link: "https://start.agentweb.pro",
        message: "Transform your GTM workflows with AI automation.",
        call_to_action: { type: "LEARN_MORE" }
      }
    }
  }
});

// 5. Create ad
const ad = call_meta_marketing_api({
  operation: "CREATE",
  entityType: "ad",
  data: {
    name: "Ad 1",
    adset_id: adSet.id,
    creative: { creative_id: creative.id },
    status: "PAUSED"
  }
});
```

**Related tools:**
- `list_connected_accounts` — Get ad account ID
- `get_meta_ads_metrics` — Quick campaign metrics
- `call_meta_ads_insights_api` — Detailed reporting

---

#### `call_meta_ads_insights_api`

**What it does:** Fetches detailed performance reporting from Meta Ads Insights API (async).

**When to use:** Need granular reporting with breakdowns (by age, gender, placement, etc.).

**Parameters:**
- `accountId` — Ad account ID
- `level` — Reporting level: `account`, `campaign`, `adset`, `ad`
- `datePreset` — Date range: `today`, `yesterday`, `last_7d`, `last_30d`, `lifetime`, or custom `date_start`/`date_end`
- `fields` — Array of metric fields to fetch:
  - `impressions`, `clicks`, `spend`, `cpc`, `cpm`, `ctr`
  - `reach`, `frequency`, `unique_clicks`
  - `actions` (conversions), `cost_per_action_type`
  - Many more (see [Meta Ads Insights Reference](https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats))
- `breakdowns` — (Optional) Array of breakdowns:
  - `age`, `gender`, `country`, `region`, `dma`, `placement`
  - `device_platform`, `publisher_platform`, `impression_device`

**Returns:** Array of insight objects (one per breakdown dimension)

**Example:**
```javascript
call_meta_ads_insights_api({
  accountId: "act_123456",
  level: "campaign",
  datePreset: "last_30d",
  fields: ["campaign_name", "impressions", "clicks", "spend", "cpc", "cpm", "ctr"],
  breakdowns: ["age", "gender"]
})
```

**Related tools:**
- `get_meta_ads_metrics` — Simpler, pre-built metrics dashboard
- `call_meta_marketing_api` — Manage campaigns

---

#### `get_meta_ads_metrics`

**What it does:** Quick, pre-built dashboard for Meta Ads campaign performance. Returns high-level metrics without needing to specify fields.

**When to use:** Quick check on campaign performance without needing custom breakdowns.

**Parameters:**
- `accountId` — Ad account ID
- `dateRange` — Date range: `last_7d`, `last_30d`, `last_90d`

**Returns:**
- `campaigns` — Array of campaign objects with:
  - `name`, `id`, `status`
  - `impressions`, `clicks`, `spend`, `cpc`, `cpm`, `ctr`
  - `conversions`, `cost_per_conversion`

**Example:**
```javascript
get_meta_ads_metrics({
  accountId: "act_123456",
  dateRange: "last_30d"
})
```

**Related tools:**
- `call_meta_ads_insights_api` — More detailed reporting
- `list_meta_ads_campaigns` — List all campaigns

---

#### `list_meta_ads_campaigns`

**What it does:** Lists all campaigns in a Meta ad account with basic info (names, IDs, statuses).

**Parameters:**
- `accountId` — Ad account ID

**Returns:** Array of campaign objects with `id`, `name`, `status`, `objective`

**Example:**
```javascript
list_meta_ads_campaigns({ accountId: "act_123456" })
```

**Related tools:**
- `call_meta_marketing_api` — Create/manage campaigns
- `get_meta_ads_metrics` — Get campaign performance

---

### 6. GTM Planning Tools

#### `create_gtm_plan`

**What it does:** Creates a new Go-To-Market plan with metadata (name, description, target date).

**Parameters:**
- `name` — Plan name (e.g., "Q2 Product Launch")
- `description` — Plan description
- `targetDate` — (Optional) Target launch date (ISO 8601)

**Returns:**
- `planId` — Newly created plan ID
- `name`, `description`, `targetDate`
- `createdAt`

**Example:**
```javascript
create_gtm_plan({
  name: "Q2 2026 Product Launch",
  description: "Launch new AI automation feature",
  targetDate: "2026-06-01T00:00:00Z"
})
```

**Workflow chain:**
1. **THIS TOOL** → create plan
2. `add_gtm_phase` → add phases (Pre-launch, Launch, Post-launch)
3. `add_gtm_work_items` → add work items to each phase
4. `send_gtm_status_report` → share plan with team

**Related tools:**
- `list_gtm_plans` — List all plans
- `add_gtm_phase` — Add phases

---

#### `add_gtm_phase`

**What it does:** Adds a phase to a GTM plan (e.g., "Pre-launch", "Launch", "Post-launch").

**Parameters:**
- `planId` — Plan ID
- `name` — Phase name
- `description` — Phase description
- `startDate`, `endDate` — (Optional) Phase date range

**Returns:**
- `phaseId` — Newly created phase ID

**Example:**
```javascript
add_gtm_phase({
  planId: "plan-123",
  name: "Pre-launch",
  description: "Preparation and content creation",
  startDate: "2026-05-01T00:00:00Z",
  endDate: "2026-05-31T00:00:00Z"
})
```

**Related tools:**
- `add_gtm_work_items` — Add work items to phase
- `update_gtm_phase` — Update phase metadata

---

#### `add_gtm_work_items`

**What it does:** Adds work items (tasks) to a GTM phase.

**Parameters:**
- `phaseId` — Phase ID
- `items` — Array of work item objects:
  - `title` — Task title
  - `description` — Task description
  - `owner` — (Optional) Task owner
  - `dueDate` — (Optional) Due date
  - `status` — (Optional) Status (not_started, in_progress, completed)

**Returns:**
- `success` — Boolean
- `itemIds` — Array of created item IDs

**Example:**
```javascript
add_gtm_work_items({
  phaseId: "phase-123",
  items: [
    {
      title: "Create blog post announcing launch",
      description: "Write 2000-word article with SEO optimization",
      owner: "john@example.com",
      dueDate: "2026-05-15T00:00:00Z",
      status: "not_started"
    },
    {
      title: "Set up Meta Ads campaign",
      description: "Create ad sets targeting enterprise SaaS",
      owner: "jane@example.com",
      dueDate: "2026-05-20T00:00:00Z",
      status: "not_started"
    }
  ]
})
```

**Related tools:**
- `update_gtm_work_item` — Update item status/details
- `get_gtm_common_items` — Browse reusable task templates

---

#### `update_gtm_work_item`

**What it does:** Updates a work item (change status, owner, due date, etc.).

**Parameters:**
- `itemId` — Work item ID
- `updates` — Object with fields to update (title, description, owner, dueDate, status)

**Example:**
```javascript
update_gtm_work_item({
  itemId: "item-123",
  updates: {
    status: "completed",
    completedAt: "2026-05-14T00:00:00Z"
  }
})
```

**Related tools:**
- `add_gtm_work_items` — Create work items
- `send_gtm_status_report` — Send progress update

---

#### `send_gtm_status_report`

**What it does:** Generates and sends a GTM plan status report via email.

**Parameters:**
- `planId` — Plan ID
- `recipients` — Array of email addresses

**Returns:**
- `success` — Boolean
- `reportUrl` — URL to HTML report (also sent via email)

**Example:**
```javascript
send_gtm_status_report({
  planId: "plan-123",
  recipients: ["team@example.com", "stakeholders@example.com"]
})
```

**Related tools:**
- `read_gtm_plan` — Get plan details
- `update_gtm_work_item` — Update items before sending report

---

### 7. Media Generation Tools

#### `generate_image`

**What it does:** Generates AI images using Google Veo, Runway, or other providers. Supports:
- Text-to-image generation
- Image revision/editing
- Style control (photorealistic, illustration, 3D, etc.)

**Parameters:**
- `prompt` — Text description of desired image
- `style` — (Optional) Style preset:
  - `photorealistic`, `illustration`, `3d_render`, `pixel_art`, `oil_painting`, `watercolor`
- `aspectRatio` — (Optional) Aspect ratio:
  - `1:1` (square), `16:9` (landscape), `9:16` (portrait), `4:3`, `3:2`
- `imageUrl` — (Optional) Base image URL for revision/editing
- `revisionPrompt` — (Optional) Changes to make to base image

**Returns:**
- `imageUrl` — S3 URL to generated image
- `width`, `height` — Image dimensions
- `provider` — AI provider used (google_veo, runway, etc.)

**Example — Generate from scratch:**
```javascript
generate_image({
  prompt: "A futuristic dashboard showing AI-powered automation, clean UI, blue and purple color scheme, high-tech aesthetic",
  style: "photorealistic",
  aspectRatio: "16:9"
})
```

**Example — Revise existing image:**
```javascript
generate_image({
  prompt: "Original prompt here",
  imageUrl: "https://s3.amazonaws.com/original-image.jpg",
  revisionPrompt: "Make the background darker and add glowing effects"
})
```

**Related tools:**
- `generate_video` — Video generation
- `describe_image` — Analyze/caption images

---

#### `generate_video`

**What it does:** Generates AI videos using Runway, Google Veo, HeyGen, Luma, or Pika.

**Parameters:**
- `prompt` — Text description of desired video
- `duration` — (Optional) Video duration in seconds (default: 5, max: 30)
- `provider` — (Optional) AI provider:
  - `runway`, `google_veo`, `heygen`, `luma`, `pika`
- `imageUrl` — (Optional) First frame image (for image-to-video)

**Returns:**
- `videoUrl` — S3 URL to generated video
- `duration` — Actual duration
- `provider` — Provider used

**Example:**
```javascript
generate_video({
  prompt: "Camera slowly zooming into a futuristic city at night, neon lights, cyberpunk aesthetic",
  duration: 10,
  provider: "runway"
})
```

**Related tools:**
- `generate_image` — Image generation
- `describe_video` — Video analysis

---

#### `describe_image`

**What it does:** Analyzes an image and generates a detailed text description. Useful for:
- Alt text generation
- Image cataloging
- Content moderation
- Reverse image search prep

**Parameters:**
- `imageUrl` — Image URL to analyze

**Returns:**
- `description` — Detailed text description
- `tags` — Array of detected tags/keywords
- `objects` — Array of detected objects
- `colors` — Dominant colors (hex codes)

**Example:**
```javascript
describe_image({
  imageUrl: "https://s3.amazonaws.com/product-screenshot.jpg"
})
// Returns:
{
  description: "A modern dashboard interface showing charts and graphs...",
  tags: ["dashboard", "analytics", "charts", "ui", "modern"],
  objects: ["chart", "graph", "button", "sidebar"],
  colors: ["#4A90E2", "#50E3C2", "#F5A623"]
}
```

**Related tools:**
- `generate_image` — Generate images
- `remove_c2pa_from_image` — Strip metadata

---

#### `describe_video`

**What it does:** Analyzes a video and generates a description of its content.

**Parameters:**
- `videoUrl` — Video URL to analyze

**Returns:**
- `description` — Text description of video content
- `duration` — Video duration
- `scenes` — Array of detected scenes with timestamps

**Example:**
```javascript
describe_video({
  videoUrl: "https://s3.amazonaws.com/product-demo.mp4"
})
```

**Related tools:**
- `generate_video` — Generate videos

---

#### `remove_c2pa_from_image`

**What it does:** Strips C2PA metadata (provenance, AI generation markers) from an image. Useful for:
- Removing "Made with AI" watermarks
- Stripping EXIF data for privacy
- Preparing images for platforms that flag AI content

**Parameters:**
- `imageUrl` — Image URL

**Returns:**
- `cleanedImageUrl` — URL to cleaned image (no metadata)

**Example:**
```javascript
remove_c2pa_from_image({
  imageUrl: "https://s3.amazonaws.com/ai-generated-image.jpg"
})
```

**Related tools:**
- `generate_image` — Generate images (with C2PA markers)

---

### 8. Research Tools

#### `perform_deep_research`

**What it does:** Runs comprehensive deep research using Gemini Deep Research. Generates a detailed markdown report with:
- Topic overview and key findings
- Sources (web pages, articles, papers)
- Structured insights and analysis
- Recommendations and conclusions

**When to use:** Need thorough research on a topic before creating content or making decisions.

**Parameters:**
- `query` — Research query/question
- `maxSources` — (Optional) Max number of sources to analyze (default: 10, max: 50)

**Returns:**
- `reportUrl` — S3 URL to markdown research report
- `sourcesCount` — Number of sources analyzed
- `wordCount` — Report word count

**Example:**
```javascript
perform_deep_research({
  query: "What are the latest trends in AI-powered marketing automation for enterprise SaaS companies?",
  maxSources: 20
})
```

**Workflow chain:**
1. **THIS TOOL** → research topic
2. Download and read report from S3
3. `create_blog_article` → use research for blog post
4. OR `create_gtm_plan` → use insights for GTM strategy

**Related tools:**
- `create_blog_article` — Use research for content
- `search_knowledge_base` — Search internal docs

---

### 9. Knowledge Base Tools

#### `search_knowledge_base`

**What it does:** Searches the user's private knowledge base (PDFs, text files, docs) using semantic search.

**When to use:** Need to reference internal docs, product specs, or company information.

**Parameters:**
- `query` — Search query
- `maxResults` — (Optional) Max results to return (default: 5, max: 10)

**Returns:** Array of matching documents with:
- `filename` — Document filename
- `excerpt` — Relevant excerpt
- `score` — Relevance score
- `url` — Document URL (if accessible)

**Example:**
```javascript
search_knowledge_base({
  query: "product pricing tiers and features",
  maxResults: 5
})
```

**Related tools:**
- `list_knowledge_base_files` — List all files
- `read_knowledge_base_files` — Read full file content
- `attach_knowledge_base_files` — Add new files

---

#### `list_knowledge_base_files`

**What it does:** Lists all files in the user's knowledge base.

**Returns:** Array of file objects with `filename`, `size`, `uploadedAt`, `url`

**Example:**
```javascript
list_knowledge_base_files()
```

**Related tools:**
- `read_knowledge_base_files` — Read file content
- `search_knowledge_base` — Search files

---

#### `read_knowledge_base_files`

**What it does:** Reads the full content of one or more knowledge base files.

**Parameters:**
- `filenames` — Array of filenames to read

**Returns:** Array of file content objects with `filename`, `content`

**Example:**
```javascript
read_knowledge_base_files({
  filenames: ["product-spec.pdf", "brand-guidelines.pdf"]
})
```

**Related tools:**
- `list_knowledge_base_files` — List available files
- `search_knowledge_base` — Search file content

---

#### `attach_knowledge_base_files`

**What it does:** Attaches/uploads new files to the knowledge base.

**Parameters:**
- `files` — Array of file objects with `url`, `filename`, `description`

**Returns:**
- `success` — Boolean
- `uploadedFiles` — Array of uploaded file details

**Example:**
```javascript
attach_knowledge_base_files({
  files: [
    {
      url: "https://example.com/document.pdf",
      filename: "product-roadmap-q2.pdf",
      description: "Q2 2026 product roadmap"
    }
  ]
})
```

**Related tools:**
- `list_knowledge_base_files` — List all files
- `search_knowledge_base` — Search uploaded files

---

### 10. Automation & Workflow Tools

#### `create_work_plan`

**What it does:** Creates a structured work plan for the current chat session. Used by Emma internally to track multi-step workflows.

**When to use:** Starting a complex workflow with multiple steps (e.g., blog creation + social promo + email campaign).

**Parameters:**
- `title` — Work plan title
- `steps` — Array of step objects:
  - `stepCount` — Step number (1, 2, 3, ...)
  - `title` — Step title
  - `description` — (Optional) Step description
  - `requiredFunctionCalls` — (Optional) Array of tool names that must be called before step is complete

**Returns:**
- `workPlanId` — Created work plan ID

**Example:**
```javascript
create_work_plan({
  title: "Blog Post Creation and Promotion",
  steps: [
    {
      stepCount: 1,
      title: "Research topic",
      requiredFunctionCalls: ["perform_deep_research"]
    },
    {
      stepCount: 2,
      title: "Create blog article",
      requiredFunctionCalls: ["create_blog_article"]
    },
    {
      stepCount: 3,
      title: "Publish to CMS",
      requiredFunctionCalls: ["publish_blog_article"]
    },
    {
      stepCount: 4,
      title: "Promote on social media",
      requiredFunctionCalls: ["create_social_media_posts", "post_on_connected_account"]
    }
  ]
})
```

**Related tools:**
- `modify_work_plan` — Update work plan
- `set_work_plan_status` — Mark plan complete

---

#### `create_task_from_prompt`

**What it does:** Creates a browser automation task from a free-text prompt. The task runs asynchronously in an isolated browser.

**When to use:** Need to automate web interactions (scraping, form filling, clicking, etc.).

**Parameters:**
- `prompt` — Task description (e.g., "Go to example.com, fill out contact form, and submit")
- `credentials` — (Optional) Website credentials if login required
- `schedule` — (Optional) Recurring schedule (daily, weekly, monthly)

**Returns:**
- `taskId` — Created task ID
- `executionId` — Initial execution ID (queued)

**Example:**
```javascript
create_task_from_prompt({
  prompt: "Go to competitor.com, navigate to pricing page, take screenshots of all pricing tiers, and download as PDF",
  schedule: "weekly"
})
```

**Task execution:**
- Tasks run asynchronously in a Playwright browser
- Results (screenshots, downloads, logs) stored in S3
- Email notification sent when complete

**Related tools:**
- `create_task_from_template` — Use a pre-built template
- `portal_execute_task` — Execute task immediately
- `list_task_templates` — Browse templates

---

#### `create_task_from_template`

**What it does:** Creates a browser automation task from a pre-built template.

**Parameters:**
- `templateId` — Template ID (from `list_task_templates`)
- `templateInputs` — Object with template-specific inputs

**Example:**
```javascript
list_task_templates()
// Returns: [{ templateId: "scrape-linkedin-profile", name: "Scrape LinkedIn Profile", inputs: ["profileUrl"] }]

create_task_from_template({
  templateId: "scrape-linkedin-profile",
  templateInputs: {
    profileUrl: "https://www.linkedin.com/in/example"
  }
})
```

**Related tools:**
- `list_task_templates` — Browse templates
- `create_task_from_prompt` — Create from scratch

---

#### `portal_create_schedule`

**What it does:** Creates a recurring schedule for a task (daily, weekly, monthly).

**Parameters:**
- `taskId` — Task ID to schedule
- `frequency` — Frequency type: `daily`, `weekly`, `monthly`
- `time` — Time of day (HH:MM format, 24-hour)
- `dayOfWeek` — (For weekly) Day of week (0-6, 0=Sunday)
- `dayOfMonth` — (For monthly) Day of month (1-31)

**Example:**
```javascript
portal_create_schedule({
  taskId: "task-123",
  frequency: "weekly",
  time: "09:00",
  dayOfWeek: 1  // Monday
})
```

**Related tools:**
- `portal_list_schedules` — List all schedules
- `portal_update_schedule` — Update schedule
- `portal_delete_schedule` — Delete schedule

---

#### Website Scan

**What it is:** Not a single dedicated tool — a workflow built from `create_task_from_prompt` (or `create_task_from_template` if a matching template exists) plus `schedule`, used to have the agent visit and audit a live website like a real visitor and report directly-observable issues: broken links, slow load times, missing meta tags, layout problems, error pages, unclear copy.

**Example:**
```javascript
create_task_from_prompt({
  prompt: "Visit example.com and check for broken links, slow-loading pages, missing meta tags, layout problems, error pages, and unclear copy. For each issue found, include a suggested fix.",
  schedule: "weekly"
})
```

**Do not confuse this with:** SEO/GEO metrics tools (report Search Console/Analytics performance for connected properties — no browsing involved) or a GTM Positioning Audit (analyzes how AI models interpret a site's messaging, not a live browse-and-audit).

---

## Complete Workflows

### Workflow 1: Write, Publish, and Promote a Blog Post

```javascript
// Step 1: Get brand voice
const brand = read_brand_guidelines();

// Step 2: Understand target audience
const strategy = read_market_strategy();

// Step 3: Research topic
const research = perform_deep_research({
  query: "AI automation trends in enterprise SaaS 2026",
  maxSources: 15
});

// Step 4: Create blog article
const article = create_blog_article({
  topic: "How AI Automation is Transforming Enterprise SaaS in 2026",
  keywords: ["AI automation", "enterprise SaaS", "workflow automation"],
  tone: brand.toneOfVoice
});

// Step 5: Publish to CMS
const published = publish_blog_article({
  title: article.title,
  description: article.description,
  content: article.content,
  imageUrl: article.heroImageUrl,
  imageFilename: "hero-image.jpg"
});

// Step 6: Create social media posts
const socialPosts = create_social_media_posts({
  topic: `New blog post: ${article.title}`,
  platforms: ["linkedin", "twitter"],
  callToAction: "Read more on our blog"
});

// Step 7: Get connected accounts
const accounts = list_connected_accounts();
const linkedinAccount = accounts.find(acc => acc.platform === "linkedin");

// Step 8: Publish to LinkedIn
post_on_connected_account({
  accountId: linkedinAccount.accountId,
  content: socialPosts.find(p => p.platform === "linkedin").content,
  linkUrl: published.publishedUrl
});
```

---

### Workflow 2: Lead Outreach Campaign

```javascript
// Step 1: Create lead list
const list = create_lead_list({
  name: "Q2 Enterprise Outreach",
  description: "Director+ titles at Fortune 500 companies"
});

// Step 2: Import leads (from CSV or array)
add_leads_to_list({
  list_id: list.listId,
  leads: [
    { email: "cto@example.com", firstName: "Jane", lastName: "Doe", company: "Example Corp", title: "CTO" },
    { email: "vp@startup.com", firstName: "John", lastName: "Smith", company: "Startup Inc", title: "VP Engineering" }
  ]
});

// Step 3: Configure custom statuses
configure_lead_statuses({
  list_id: list.listId,
  statuses: ["New", "Contacted", "Replied", "Qualified", "Meeting Scheduled", "Closed"]
});

// Step 4: Search for high-value leads
const targetLeads = search_leads({
  list_id: list.listId,
  filters: [
    { field: "title", operator: "contains", value: "Director" },
    { field: "company", operator: "not_equals", value: "" }
  ],
  limit: 50
});

// Step 5: Send personalized emails
for (const lead of targetLeads) {
  send_email_to_lead({
    leadId: lead.leadId,
    subject: `Quick question for ${lead.company}`,
    body: `Hi ${lead.firstName},\n\nI noticed ${lead.company} is scaling quickly...\n\nBest,\nJohn`
  });

  // Update status
  update_lead_status({
    leadId: lead.leadId,
    status: "Contacted"
  });
}

// Step 6: Monitor engagement
const engagements = get_task_subscriber_engagement_events({
  list_id: list.listId,
  startDate: "2026-03-01T00:00:00Z"
});

// Step 7: Follow up with engaged leads
const engagedLeads = engagements.filter(e => e.event === "open" || e.event === "click");
for (const engagement of engagedLeads) {
  const lead = get_lead_details({ email: engagement.leadEmail });

  // Send follow-up
  send_email_to_lead({
    leadId: lead.leadId,
    subject: "Following up",
    body: `Hi ${lead.firstName},\n\nI wanted to follow up on my previous email...\n\nBest,\nJohn`
  });
}
```

---

### Workflow 3: Create and Run a Meta Ads Campaign

```javascript
// Step 1: Get Meta ad account
const accounts = list_connected_accounts();
const metaAccount = accounts.find(acc => acc.platform === "meta" && acc.accountType === "ad_account");

// Step 2: Create campaign
const campaign = call_meta_marketing_api({
  operation: "CREATE",
  entityType: "campaign",
  accountId: metaAccount.accountId,
  data: {
    name: "Q2 Lead Gen Campaign",
    objective: "OUTCOME_LEADS",
    status: "PAUSED",
    special_ad_categories: []
  }
});

// Step 3: Create ad set
const adSet = call_meta_marketing_api({
  operation: "CREATE",
  entityType: "adset",
  accountId: metaAccount.accountId,
  data: {
    name: "Enterprise SaaS Ad Set",
    campaign_id: campaign.id,
    daily_budget: 10000, // $100/day in cents
    billing_event: "IMPRESSIONS",
    optimization_goal: "LEAD_GENERATION",
    targeting: {
      geo_locations: { countries: ["US"] },
      age_min: 25,
      age_max: 65,
      interests: [
        { id: "6003139266461", name: "Business software" },
        { id: "6003020834693", name: "Enterprise software" }
      ]
    },
    start_time: "2026-03-10T00:00:00Z",
    end_time: "2026-04-10T00:00:00Z"
  }
});

// Step 4: Upload creative image
const image = call_meta_marketing_api({
  operation: "UPLOAD_IMAGE",
  entityType: "adimage",
  accountId: metaAccount.accountId,
  data: {
    imageUrl: "https://s3.amazonaws.com/ad-creative.jpg"
  }
});

// Step 5: Create ad creative
const creative = call_meta_marketing_api({
  operation: "CREATE",
  entityType: "adcreative",
  accountId: metaAccount.accountId,
  data: {
    name: "Lead Gen Creative",
    object_story_spec: {
      page_id: "page-123",
      link_data: {
        image_hash: image.image_hash,
        link: "https://start.agentweb.pro",
        message: "Transform your GTM workflows with AI automation. Get started free.",
        name: "AgentWeb - AI-Powered GTM Automation",
        description: "Automate blog publishing, social media, lead management, and more.",
        call_to_action: { type: "LEARN_MORE" }
      }
    }
  }
});

// Step 6: Create ad
const ad = call_meta_marketing_api({
  operation: "CREATE",
  entityType: "ad",
  accountId: metaAccount.accountId,
  data: {
    name: "Lead Gen Ad 1",
    adset_id: adSet.id,
    creative: { creative_id: creative.id },
    status: "PAUSED"  // Review before activating
  }
});

// Step 7: Activate campaign (after review)
call_meta_marketing_api({
  operation: "UPDATE",
  entityType: "campaign",
  accountId: metaAccount.accountId,
  entityId: campaign.id,
  data: { status: "ACTIVE" }
});

// Step 8: Monitor performance
const metrics = get_meta_ads_metrics({
  accountId: metaAccount.accountId,
  dateRange: "last_7d"
});

// Step 9: Get detailed insights
const insights = call_meta_ads_insights_api({
  accountId: metaAccount.accountId,
  level: "ad",
  datePreset: "last_7d",
  fields: ["ad_name", "impressions", "clicks", "spend", "cpc", "actions", "cost_per_action_type"],
  breakdowns: ["age", "gender"]
});
```

---

## Best Practices

### 1. Always Read Brand Guidelines First

Before creating ANY content (blogs, social posts, emails, ads), call:
```javascript
read_brand_guidelines()
read_market_strategy()
```

This ensures content matches brand voice and targets the right audience.

---

### 2. Use Structured Search for Precision

When searching leads, use `search_leads` with field-level filters instead of `get_leads` with text search:

```javascript
// ❌ Less precise
get_leads({ list_id: "list-123", search: "director" })

// ✅ More precise
search_leads({
  list_id: "list-123",
  filters: [
    { field: "title", operator: "contains", value: "Director" },
    { field: "company", operator: "not_equals", value: "" }
  ]
})
```

---

### 3. Test Ads in PAUSED Status First

Always create Meta ads in `PAUSED` status, review them, then activate:

```javascript
// Create ad in PAUSED status
const ad = call_meta_marketing_api({
  ...
  data: { ...., status: "PAUSED" }
});

// Review ad in Meta Ads Manager, then activate
call_meta_marketing_api({
  operation: "UPDATE",
  entityType: "ad",
  entityId: ad.id,
  data: { status: "ACTIVE" }
});
```

---

### 4. Chain Tools for Workflows

Don't make single-tool calls. Chain related tools together:

```javascript
// ❌ Disconnected
create_blog_article({ topic: "AI trends" });
// ... manually copy URL and publish

// ✅ Chained workflow
const article = create_blog_article({ topic: "AI trends" });
const published = publish_blog_article({
  title: article.title,
  content: article.content,
  imageUrl: article.heroImageUrl
});
const posts = create_social_media_posts({
  topic: `New post: ${article.title}`,
  linkUrl: published.publishedUrl
});
```

---

### 5. Use Work Plans for Complex Workflows

For multi-step workflows, create a work plan to track progress:

```javascript
create_work_plan({
  title: "Q2 Product Launch",
  steps: [
    { stepCount: 1, title: "Research competitors" },
    { stepCount: 2, title: "Create blog post" },
    { stepCount: 3, title: "Set up ads campaign" },
    { stepCount: 4, title: "Launch social media campaign" }
  ]
});
```

---

### 6. Monitor Social Media Performance

After posting, always check analytics:

```javascript
const post = post_on_connected_account({ ... });

// Wait 24-48 hours, then check performance
const analytics = get_post_analytics({
  accountId: post.accountId,
  postId: post.postId
});

// If underperforming, adjust strategy
if (analytics.engagementRate < 2) {
  // Try different messaging, timing, or targeting
}
```

---

### 7. Always Check Connected Accounts

Before posting or running ads, verify accounts are connected:

```javascript
const accounts = list_connected_accounts();
const hasLinkedIn = accounts.some(acc => acc.platform === "linkedin" && acc.status === "active");

if (!hasLinkedIn) {
  // Inform user to connect LinkedIn account first
}
```

---

### 8. Use Knowledge Base for Context

Before creating content, search knowledge base for relevant docs:

```javascript
const docs = search_knowledge_base({
  query: "product features and benefits",
  maxResults: 5
});

// Use docs to inform content creation
create_blog_article({
  topic: "Our product's top features",
  context: docs.map(d => d.excerpt).join("\n")
});
```

---

## Troubleshooting

### Error: "Tool requires a skill to be installed"

**Cause:** This error should NOT appear anymore (skill-gating removed).

**Fix:** If you see this, restart your MCP connection. All tools should be available immediately.

---

### Error: "CMS Type is not configured"

**Cause:** User hasn't connected a CMS (BaseHub or Webflow).

**Fix:** User must log in to AgentWeb portal and connect their CMS in Settings.

---

### Error: "Connected account not found"

**Cause:** User hasn't connected the social media or ad account.

**Fix:** Call `list_connected_accounts()` first to verify which accounts are available. If missing, user must connect via OAuth in AgentWeb portal.

---

### Error: "Rate limit exceeded"

**Cause:** Hitting platform rate limits (Meta Ads API, LinkedIn API, etc.).

**Fix:** Space out requests. Use delay between API calls:
```javascript
for (const lead of leads) {
  send_email_to_lead({ ... });
  await sleep(1000); // 1 second delay
}
```

---

### Error: "Invalid image format" or "SVG not allowed"

**Cause:** Trying to upload SVG as a logo/image.

**Fix:** Convert SVG to PNG or JPG first. Use `generate_image` or external converter.

---

## Rate Limits

- **Meta Ads API:** 200 calls per hour per ad account
- **LinkedIn API:** 100 calls per hour per access token
- **Email sending:** 1000 emails per day per user
- **Image generation:** 50 images per hour per user
- **Video generation:** 10 videos per hour per user

---

## Support

**Documentation:** https://docs.agentweb.pro
**Email Support:** support@agentweb.pro
**Community:** https://community.agentweb.pro

---

**Last updated:** March 5, 2026
**Emma version:** 2.0.0
**API version:** 1.0
