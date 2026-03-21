# Notion User Guide Setup

## Issue

The `/guide` page in the customer portal fails to load because the backend cannot fetch the Notion credentials from AWS Secrets Manager.

**Error:** `Failed to fetch secret: prod/AgentWeb/Notion`

## Root Cause

The AWS secret `prod/AgentWeb/Notion` does not exist in production. The backend's `getNotionCredentials()` function in `backend/src/services/notionService.ts` attempts to fetch this secret to get:
1. `apiToken` - Notion API token
2. `userGuidePageId` - Notion page ID for the user guide

## Solution

### 1. Create the AWS Secret

Create the secret in AWS Secrets Manager with the following structure:

**Secret Name:** `prod/AgentWeb/Notion`

**Secret Value (JSON):**
```json
{
  "apiToken": "ntn_YOUR_NOTION_API_TOKEN_HERE",
  "userGuidePageId": "YOUR-NOTION-PAGE-ID-HERE"
}
```

### 2. Get Notion API Token

1. Go to https://www.notion.so/my-integrations
2. Create a new integration or use an existing one
3. Copy the "Internal Integration Token" (starts with `ntn_`)
4. Share the user guide page with this integration:
   - Open the Notion page in your workspace
   - Click "Share" in the top right
   - Click "Invite" and select your integration

### 3. Get Notion Page ID

The page ID is in the URL of your Notion page:
- URL format: `https://www.notion.so/<workspace>/<page-id>?...`
- Example: `https://www.notion.so/myworkspace/32909247c95180038c06eefa0c2cf100`
- Page ID: `32909247-c951-8003-8c06-eefa0c2cf100` (with dashes added)

Or use the full UUID format without dashes: `32909247c95180038c06eefa0c2cf100`

### 4. Create the Secret via AWS CLI

```bash
aws secretsmanager create-secret \
  --name prod/AgentWeb/Notion \
  --description "Notion API credentials for user guide" \
  --secret-string '{"apiToken":"ntn_YOUR_TOKEN","userGuidePageId":"YOUR_PAGE_ID"}' \
  --region us-west-2
```

### 5. Grant Backend Permission

Ensure the Elastic Beanstalk instance role has permission to read this secret:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:us-west-2:992382574572:secret:prod/AgentWeb/Notion-*"
    }
  ]
}
```

## Development Environment

For development, create the secret with the name `dev/AgentWeb/Notion`:

```bash
aws secretsmanager create-secret \
  --name dev/AgentWeb/Notion \
  --description "Notion API credentials for user guide (dev)" \
  --secret-string '{"apiToken":"ntn_YOUR_DEV_TOKEN","userGuidePageId":"YOUR_PAGE_ID"}' \
  --region us-west-2
```

## Frontend Improvement

The customer portal now shows a proper error message when the secret is missing instead of loading forever:

**Before:** Shows "Loading user guide..." indefinitely

**After:** Shows a user-friendly error message with details and instructions to contact support

## Testing

After creating the secret:

1. Test the API endpoint directly:
   ```bash
   curl https://api.agentweb.pro/api/docs/user-guide
   ```

   Expected response:
   ```json
   {
     "success": true,
     "data": {
       "notionPageId": "32909247c95180038c06eefa0c2cf100"
     }
   }
   ```

2. Visit https://app.agentweb.pro/guide and verify the Notion page loads correctly

## Related Files

- `backend/src/services/notionService.ts` - Fetches Notion credentials
- `backend/src/controllers/user-guide.ts` - API endpoint handler
- `backend/src/routes/user-guide.ts` - Route definition
- `customer-portal/src/pages/GuidePage.tsx` - Frontend page component
