# Emma by AgentWeb — Agent Skill Guide

Emma is an AI marketing assistant built on [AgentWeb](https://agentweb.pro). She helps businesses automate marketing workflows — from blog publishing and social media campaigns to lead management, ad operations, and browser automation.

This document is designed for **external AI agents** connecting to Emma via the Model Context Protocol (MCP). It describes every available tool, how authentication works, and provides step-by-step workflows for common tasks.

---

## Authentication

### Getting an API Key

1. Log in to your AgentWeb partner portal at `https://agentweb.pro`
2. Navigate to **Settings > API Keys**
3. Generate an MCP access token

### Connecting via MCP

Emma exposes a Streamable HTTP MCP server. Configure your MCP client to connect:

```json
{
  "mcpServers": {
    "emma": {
      "type": "streamable-http",
      "url": "https://api.agentweb.pro/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_ACCESS_TOKEN"
      }
    }
  }
}
```

The server uses session-based transport. Sessions auto-expire after 1 hour of inactivity.

---

## Skills System

Emma uses a **skills system** to organize tools into logical bundles. When you first connect, only the `install_skills` tool is available. You must install one or more skills before their tools become accessible.

### `install_skills`

Install skill bundles by ID to unlock their tools.

- Pass an array of `skillIds` to install.
- Use `__other_skills__` to install tools that aren't part of any named skill.
- Once installed, the skill's tools remain available for the rest of the session.

**Example:**
```json
{
  "skillIds": ["blogging", "social_media", "__other_skills__"]
}
```

> **Tip:** When starting a session, call `install_skills` with `__other_skills__` to get access to all tools at once.

---

## Tool Reference

Below is every tool organized by category. Each entry includes the tool name and a brief description.

### Brand & Market Strategy

| Tool | Description |
|------|-------------|
| `read_brand_guidelines` | Read the user's brand guidelines (logos, colors, fonts, tone, founders) |
| `update_brand_guidelines` | Update brand data and assets |
| `read_market_strategy` | Read the user's market strategy (business overview, competitors, ICPs) |
| `update_market_strategy` | Update business overview, competitors, and ideal customer profiles |

### Blog & Content Publishing

| Tool | Description |
|------|-------------|
| `create_blog_article` | Create a complete blog article with content, images, and HTML |
| `publish_blog_article` | Publish a blog article to a CMS (BaseHub or Webflow) |
| `list_cms_categories` | List available CMS categories for publishing |
| `repair_blog_article` | Repair a blog article by re-optimizing images |

### Books & White Papers

| Tool | Description |
|------|-------------|
| `list_books` | List all books and white papers |
| `get_book_details` | Get book metadata, characters, and outline structure |
| `get_book_content` | Get markdown content for a section or chapter |
| `update_book_content` | Update content using partial text replacements |
| `generate_book_content` | Generate AI content for a book section/chapter |
| `create_book` | Create a new book or white paper with metadata |
| `create_book_outline` | Create the complete outline structure (sections and chapters) |
| `add_characters` | Add characters to a book |

### Social Media & Connected Accounts

| Tool | Description |
|------|-------------|
| `list_connected_accounts` | List connected social media accounts (LinkedIn, Meta, etc.) |
| `list_connected_account_posts` | List posts from a connected account |
| `load_connected_account_metrics` | Load metrics for connected social media accounts |
| `get_post_analytics` | Get detailed analytics for specific social media posts |
| `create_social_media_posts` | Create social media posts |
| `post_on_connected_account` | Publish content to a connected social media account |
| `comment_on_linkedin_post` | Comment on a LinkedIn post |
| `react_to_linkedin_post` | React (like, celebrate, etc.) to a LinkedIn post |

### Meta Ads (Facebook/Instagram)

| Tool | Description |
|------|-------------|
| `list_meta_ads_campaigns` | List all Meta ad campaigns with names, IDs, statuses |
| `call_meta_marketing_api` | Full CRUD for Meta Ads entities — campaigns, ad sets, ads, creatives, audiences, targeting, pages |
| `call_meta_ads_insights_api` | Fetch performance reporting data from Meta Ads (async insights API) |
| `get_meta_ads_metrics` | Quick pre-built dashboard for campaign performance |

### CRM & Lead Management

| Tool | Description |
|------|-------------|
| `get_lead_lists` | List all lead lists |
| `create_lead_list` | Create a new lead list |
| `get_leads` | Get leads from a specific list |
| `search_leads` | Search leads across all lists |
| `get_lead_details` | Get detailed information for a specific lead |
| `add_leads_to_list` | Add leads to a list |
| `update_lead` | Update lead fields |
| `update_lead_status` | Update a lead's status |
| `delete_leads` | Delete leads by ID |
| `update_lead_list` | Update lead list metadata |
| `delete_lead_list` | Delete a lead list |
| `get_lead_list_statuses` | Get status configuration for a lead list |
| `configure_lead_statuses` | Configure custom statuses for a lead list |
| `get_lead_engagements` | Get engagement history for a lead |
| `add_lead_engagement` | Add an engagement event for a lead |
| `send_email_to_lead` | Send an email to a lead |
| `update_email_draft_for_lead` | Update the email draft for a specific lead |

### Email & Subscriber Metrics

| Tool | Description |
|------|-------------|
| `get_task_subscriber_metrics` | Get metrics for task subscribers |
| `get_task_subscriber_engagement_events` | Get email engagement events (opens, clicks) |

### GTM (Go-To-Market) Plans

| Tool | Description |
|------|-------------|
| `list_gtm_plans` | List all GTM plans |
| `read_gtm_plan` | Read full GTM plan details |
| `create_gtm_plan` | Create a new GTM plan |
| `update_gtm_plan` | Update GTM plan metadata |
| `add_gtm_phase` | Add a phase to a GTM plan |
| `add_gtm_work_items` | Add work items to a phase |
| `update_gtm_work_item` | Update work item fields |
| `update_gtm_phase` | Update phase metadata |
| `delete_gtm_items` | Delete phases or work items |
| `get_gtm_common_items` | Get common work items library |
| `add_gtm_common_items` | Add items to the common work items library |
| `send_gtm_status_report` | Send a GTM status report via email |

### HTML Templates

| Tool | Description |
|------|-------------|
| `list_html_templates` | List available HTML templates |
| `create_html_from_template` | Create an HTML file from a template with variable replacement |
| `update_html_file` | Update an existing HTML file using partial text replacements |

### Knowledge Base

| Tool | Description |
|------|-------------|
| `create_knowledge_base` | Create a new knowledge base with initial content |
| `update_knowledge_base_file` | Update an existing knowledge base file |
| `attach_knowledge_base_files` | Attach additional files to a knowledge base |

### Media Generation

| Tool | Description |
|------|-------------|
| `generate_image` | Generate or revise images with AI |
| `generate_video` | Generate videos with AI (Runway, Google Veo, HeyGen, Luma, Pika) |

### Research

| Tool | Description |
|------|-------------|
| `perform_deep_research` | Run comprehensive deep research using Gemini Deep Research. Returns an S3 URL to a markdown report. |

### Task Automation (Browser Tasks)

| Tool | Description |
|------|-------------|
| `list_task_templates` | List available task templates |
| `create_task_from_template` | Create a browser automation task from a template |
| `create_task_from_prompt` | Create a browser automation task from a raw text prompt |

### Work Plans & Review

| Tool | Description |
|------|-------------|
| `create_work_plan` | Create a structured work plan for the current session |
| `modify_work_plan` | Modify work plan items (add, update, delete) |
| `set_work_plan_status` | Update overall work plan status |
| `send_for_review` | Send content for review via email |

---

## Common Workflows

### 1. Write and Publish a Blog Post

```
1. read_brand_guidelines          → Get brand voice and style
2. read_market_strategy           → Understand target audience
3. perform_deep_research          → Research the topic
4. create_blog_article            → Generate the article with images and HTML
5. list_cms_categories            → Find the right category
6. publish_blog_article           → Publish to BaseHub or Webflow CMS
7. list_connected_accounts        → Find LinkedIn/social accounts
8. create_social_media_posts      → Create promotional posts
9. post_on_connected_account      → Publish to social media
```

### 2. Run a LinkedIn Campaign

```
1. list_connected_accounts        → Find the LinkedIn account
2. read_brand_guidelines          → Get brand voice
3. create_social_media_posts      → Draft posts
4. post_on_connected_account      → Publish each post
5. get_post_analytics             → Monitor performance
6. load_connected_account_metrics → Review account-level metrics
```

### 3. Create and Run a Meta Ads Campaign

```
1. list_connected_accounts        → Get Meta ad account ID (platform='meta')
2. call_meta_marketing_api        → CREATE campaign (set objective)
3. call_meta_marketing_api        → CREATE ad set (budget, targeting, schedule)
4. call_meta_marketing_api        → UPLOAD_IMAGE for creative
5. call_meta_marketing_api        → CREATE ad creative (with image_hash)
6. call_meta_marketing_api        → CREATE ad (link creative to ad set)
7. get_meta_ads_metrics           → Monitor performance
8. call_meta_ads_insights_api     → Get detailed reporting breakdowns
```

### 4. Lead Outreach Sequence

```
1. create_lead_list               → Create a new list for the campaign
2. add_leads_to_list              → Import leads
3. configure_lead_statuses        → Set up custom status stages
4. get_leads                      → Review the list
5. update_email_draft_for_lead    → Customize email per lead
6. send_email_to_lead             → Send outreach email
7. get_lead_engagements           → Track opens, clicks, replies
8. update_lead_status             → Move leads through pipeline
```

### 5. Build a GTM Plan

```
1. create_gtm_plan                → Create the plan with metadata
2. add_gtm_phase                  → Add phases (e.g., "Pre-launch", "Launch", "Post-launch")
3. get_gtm_common_items           → Browse reusable work item templates
4. add_gtm_work_items             → Add work items to each phase
5. send_gtm_status_report         → Send progress report via email
```

### 6. Write a Book or White Paper

```
1. create_book                    → Create the book with metadata
2. add_characters                 → Add characters (if applicable)
3. create_book_outline            → Generate the full outline
4. generate_book_content          → Generate content for each section
5. get_book_content               → Review generated content
6. update_book_content            → Refine with partial edits
```

### 7. Create a Browser Automation Task

```
1. list_task_templates            → Browse available templates
2. create_task_from_template      → Create task from a template
   OR
   create_task_from_prompt        → Create from a free-text prompt
```

> Browser tasks run asynchronously. After creation, the task enters a queue and executes in an isolated browser session. Results (screenshots, downloads, logs) are stored in S3.

---

## Important Notes

### Async Task Execution

Browser automation tasks (`create_task_from_prompt`, `create_task_from_template`) run **asynchronously**. They are queued and executed by the agent engine in an isolated Playwright browser. Results are not returned inline — they are stored and accessible after completion.

### Connected Accounts

Social media tools (`post_on_connected_account`, `comment_on_linkedin_post`, Meta Ads tools, etc.) require the user to have connected the relevant account via OAuth in the AgentWeb portal. Use `list_connected_accounts` to check which accounts are available before attempting operations.

### Brand Context

Before generating any content (blogs, social posts, emails), read the user's brand guidelines and market strategy first. This ensures generated content matches their voice, tone, and target audience.

### Knowledge Base

Users can upload reference documents (PDFs, text files) to knowledge bases. Use `attach_knowledge_base_files` to make them available to tasks, or `create_knowledge_base` to set up a new one.

### Rate Limits

External API calls (Meta Ads, LinkedIn) are subject to the respective platform's rate limits. Emma handles retries internally, but high-volume operations should be spaced appropriately.
