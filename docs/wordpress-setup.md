# WordPress CMS Setup for Blog Publishing

This guide explains how to configure WordPress as a CMS target for blog publishing in AgentWeb.

## Prerequisites

- A self-hosted WordPress site (wordpress.org) or WordPress.com Business plan (with REST API access)
- WordPress 5.6+ (for Application Passwords support)
- A WordPress user account with **Editor** or **Administrator** role

## Step 1: Create a WordPress Application Password

Application Passwords allow API access without exposing your main password.

1. Log in to your WordPress admin dashboard
2. Go to **Users > Profile** (or **Users > All Users** and click your user)
3. Scroll down to the **Application Passwords** section
4. Enter a name (e.g., "AgentWeb") and click **Add New Application Password**
5. **Copy the generated password immediately** - it won't be shown again
   - It will look like: `abcd EFGH 1234 ijkl MNOP 5678`

> **Note:** If you don't see the Application Passwords section, ensure your site uses HTTPS and runs WordPress 5.6+. Some security plugins may also disable this feature.

## Step 2: Find Your WordPress Category IDs (Optional)

If you want AgentWeb to assign categories to published posts:

1. Go to **Posts > Categories** in your WordPress admin
2. Hover over each category and note the `tag_ID` from the URL (e.g., `...?tag_ID=3`)
3. Or use the REST API to list all categories:
   ```
   GET https://your-site.com/wp-json/wp/v2/categories
   ```
   Each category object has an `id` field (integer).

## Step 3: Store Credentials in AWS Secrets Manager

Create a secret in AWS Secrets Manager with the following JSON structure:

**Secret name:** `dev/AgentWeb/WordPress` (development) or `prod/AgentWeb/WordPress` (production)

For per-user configuration, use: `dev/AgentWeb/WordPress/<userId>` or `prod/AgentWeb/WordPress/<userId>`

```json
{
  "siteUrl": "https://your-wordpress-site.com",
  "username": "your-wordpress-username",
  "applicationPassword": "abcd EFGH 1234 ijkl MNOP 5678",
  "categories": {
    "Technology": 3,
    "Marketing": 5,
    "AI & Machine Learning": 12
  }
}
```

### Field Reference

| Field | Required | Description |
|---|---|---|
| `siteUrl` | Yes | Your WordPress site URL (no trailing slash) |
| `username` | Yes | WordPress username with Editor/Admin role |
| `applicationPassword` | Yes | The Application Password generated in Step 1 |
| `categories` | No | Map of display name to WordPress category ID (integer) |

### AWS CLI Example

```bash
aws secretsmanager create-secret \
  --name "dev/AgentWeb/WordPress" \
  --secret-string '{
    "siteUrl": "https://your-site.com",
    "username": "admin",
    "applicationPassword": "abcd EFGH 1234 ijkl MNOP 5678",
    "categories": {"Technology": 3, "Marketing": 5}
  }' \
  --region us-west-2
```

## Step 4: Set the User's CMS Type to WordPress

Via the admin API:

```bash
curl -X PUT https://api.agentweb.pro/api/admin/users/<userId>/cms-type \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"cmsType": "WordPress"}'
```

Or in the Partner Portal admin UI, set the user's CMS Type to "WordPress".

## Step 5: Test Publishing

1. Start a chat session with Emma (agent mode)
2. Ask Emma to write and publish a blog post
3. The post will be created via the WordPress REST API (`POST /wp-json/wp/v2/posts`)
4. Featured images are automatically uploaded to the WordPress media library

## How It Works

- **Authentication:** Uses HTTP Basic Auth with Application Passwords (standard WordPress auth method)
- **Post creation:** `POST /wp-json/wp/v2/posts` with title, content (HTML), excerpt, status, categories, and featured image
- **Image upload:** `POST /wp-json/wp/v2/media` uploads the hero image and sets it as `featured_media`
- **Draft vs Published:** Controlled by the `status` field (`draft` or `publish`)

## Troubleshooting

### "rest_cannot_create" or 403 Forbidden
- The WordPress user doesn't have sufficient permissions. Use an Editor or Administrator account.

### "rest_no_route" or 404
- The WordPress REST API may be disabled. Check that `https://your-site.com/wp-json/wp/v2/posts` returns a valid response.
- Some plugins (like Disable REST API) may block unauthenticated discovery. Try with auth headers.

### Application Passwords section not visible
- Ensure your site uses HTTPS (required for Application Passwords)
- Check that no security plugin is disabling Application Passwords
- Verify WordPress version is 5.6+

### Image upload fails but post publishes
- The post will still be created without a featured image
- Check that the WordPress user has `upload_files` capability
- Verify the WordPress `upload_max_filesize` PHP setting is large enough
