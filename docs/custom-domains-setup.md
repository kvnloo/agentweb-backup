# Custom Domains for Landing Pages

## Architecture

Landing pages are deployed to Vercel. Custom domains are managed via:
1. **DynamoDB** (`AW-CustomDomains` table) — stores domain records per user
2. **Vercel Domain API** — adds/removes/verifies domains on Vercel projects
3. **Backend API** (`/api/domains/*`) — CRUD operations for domain management
4. **Frontend UI** — Domain Settings component in the Landing Pages section

## Phase 1: agentwebforms.com Subdomains (Current)

### DNS Setup (One-time, Manual)

Add a wildcard CNAME record in Route 53 for `agentwebforms.com`:

```
*.agentwebforms.com  →  CNAME  →  cname.vercel-dns.com.
```

**Steps:**
1. Go to AWS Route 53 → Hosted Zones → `agentwebforms.com`
2. Create a new record:
   - **Record name:** `*`
   - **Record type:** CNAME
   - **Value:** `cname.vercel-dns.com.`
   - **TTL:** 300
3. Also add the apex domain to Vercel:
   - **Record name:** (blank / @)
   - **Record type:** A
   - **Value:** `76.76.21.21` (Vercel's IP)
   - **TTL:** 300

### How It Works

1. User deploys a landing page → Vercel project is created
2. System auto-generates a subdomain from the page name (e.g., `my-cool-page.agentwebforms.com`)
3. Subdomain is added to the Vercel project via API
4. Wildcard DNS routes `*.agentwebforms.com` to Vercel
5. Vercel auto-provisions SSL and serves the correct project

### DynamoDB Table Schema

**Table:** `AW-CustomDomains` (or `Dev-AW-CustomDomains` in development)

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | String (PK) | UUID |
| `userId` | String (GSI) | User who owns this domain |
| `domain` | String | Full domain name |
| `type` | String | `subdomain` or `custom` |
| `status` | String | `active`, `pending_verification`, `error` |
| `vercelProjectId` | String | Linked Vercel project |
| `verificationRecords` | List | DNS records needed for verification |
| `createdAt` | String | ISO timestamp |
| `updatedAt` | String | ISO timestamp |

**GSI:** `userId-index` on `userId` for listing user domains

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/domains?projectId=xxx` | List domains for user |
| `GET` | `/api/domains/:id` | Get specific domain |
| `POST` | `/api/domains/subdomain` | Add subdomain (body: `{vercelProjectId, subdomain}`) |
| `POST` | `/api/domains/custom` | Add custom domain (body: `{vercelProjectId, domain}`) |
| `DELETE` | `/api/domains/:id` | Remove a domain |
| `POST` | `/api/domains/:id/verify` | Check DNS verification |

## Phase 2: Custom Domain via Route 53 (Deferred)

### Plan

For fully custom domains (e.g., `landing.customer.com`), users will:

1. Add their domain in the UI
2. Get CNAME/TXT verification records
3. Configure DNS on their provider
4. Click "Verify" to confirm DNS propagation

For customers who want us to manage their DNS:
- We could add Route 53 hosted zone creation + NS delegation
- This requires AWS credentials and is a bigger scope
- Defer to Phase 2

### Route 53 Integration (Future)

When ready to implement:
1. Create Route 53 hosted zone for customer domain
2. Return NS records for customer to configure at their registrar
3. Add CNAME/A records pointing to Vercel
4. Poll for DNS propagation
5. Trigger Vercel domain verification

This requires:
- AWS IAM permissions for Route 53
- Careful handling of DNS propagation delays (up to 48h)
- Customer communication about NS record updates
