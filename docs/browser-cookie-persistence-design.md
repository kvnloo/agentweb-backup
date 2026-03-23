# Browser Cookie Persistence for Emma - Design Document

## Problem Statement

Emma needs to access account-protected pages (like Google Search Console, Analytics, social media platforms, etc.) to scrape insights and perform tasks. Currently, Playwright MCP opens a fresh browser context each time, requiring manual login for every request.

**Requirements:**
1. Enable Emma to launch browsers and login to websites
2. Persist cookies so users don't need to login repeatedly
3. Maintain security isolation between users (each user has their own cookie store)
4. Each chat session should have its own browser instance (for security and concurrency)

## Current Architecture

### Playwright MCP Integration
- **MCP Server**: Playwright MCP is configured via `.mcp.json` and auto-launches with `--headless` and `--no-sandbox`
- **Per-Session Clients**: `mcpClientService.getSessionClient()` creates separate MCP client connections per chat session
- **Tools Available**: `browser_navigate`, `browser_click`, `browser_fill_form`, `browser_run_code`, etc.
- **Emma Access**: Emma can call Playwright tools via `AgentModeService.executeTool()`

### Current Flow
```
User asks Emma → ChatbotService → AgentModeService.executeTool()
  → ToolRegistry.execute() → mcpClientService (per-session MCP client)
  → Playwright MCP Server → Browser automation
```

## Proposed Solution

### 1. Cookie Storage Schema

**New DynamoDB Table: `AW-BrowserCookies`**

```typescript
interface BrowserCookie {
  userId: string;              // Partition key
  domain: string;              // Sort key (e.g., "google.com", "linkedin.com")
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  updatedAt: string;           // ISO timestamp
  createdAt: string;           // ISO timestamp
}
```

**Key Design Decisions:**
- One record per user per domain (composite key: `userId` + `domain`)
- Store all cookies for a domain in a single array (easier to load all at once)
- Cookies are stored in Playwright's native format for easy injection
- No encryption needed (cookies are already session-specific and expire)

### 2. Cookie Management Tools

**New Internal Emma Tools:**

#### `save_browser_cookies`
Extracts cookies from the current browser context and saves them to DynamoDB.
```typescript
{
  name: "save_browser_cookies",
  description: "Save browser cookies for the current domain so you can reuse them in future sessions. Call this after successfully logging into a website.",
  parameters: {
    domain: string;  // e.g., "google.com", "linkedin.com"
  }
}
```

#### `load_browser_cookies`
Loads saved cookies from DynamoDB and injects them into the browser context.
```typescript
{
  name: "load_browser_cookies",
  description: "Load previously saved cookies for a domain into the browser. Call this before navigating to a website that requires authentication.",
  parameters: {
    domain: string;  // e.g., "google.com", "linkedin.com"
  }
}
```

#### `list_saved_domains`
Lists all domains that have saved cookies for the current user.
```typescript
{
  name: "list_saved_domains",
  description: "List all domains that have saved login cookies. Useful to check if you need to login or can reuse existing cookies.",
  parameters: {}
}
```

#### `clear_browser_cookies`
Clears saved cookies for a specific domain or all domains.
```typescript
{
  name: "clear_browser_cookies",
  description: "Clear saved cookies for a domain. Use this if cookies are expired or causing issues.",
  parameters: {
    domain?: string;  // Optional: clear specific domain, or all if omitted
  }
}
```

### 3. Implementation Details

#### Cookie Extraction via Playwright
Use `browser_run_code` to extract cookies from the current browser context:
```javascript
async (page) => {
  const context = page.context();
  const cookies = await context.cookies();
  return JSON.stringify(cookies);
}
```

#### Cookie Injection via Playwright
Use `browser_run_code` to inject cookies before navigation:
```javascript
async (page) => {
  const context = page.context();
  const cookiesToAdd = [/* cookies from DynamoDB */];
  await context.addCookies(cookiesToAdd);
  return "Cookies loaded successfully";
}
```

#### Session Isolation
- Each chat session already has its own MCP client connection (via `getSessionClient`)
- Playwright MCP maintains separate browser contexts per connection
- Cookies are loaded per-session on demand, not globally
- **Security**: Cookies are user-scoped (userId in DynamoDB key), so users can't access each other's cookies

### 4. Typical User Flow

**Initial Login:**
```
User: "Emma, login to Google Search Console"
Emma:
  1. Calls browser_navigate("https://search.google.com/search-console")
  2. Detects login page
  3. Either auto-fills credentials (if stored) or asks user to login
  4. After successful login, calls save_browser_cookies("google.com")
  5. Responds: "Successfully logged in and saved cookies for future use"
```

**Subsequent Access:**
```
User: "Emma, check my Search Console data"
Emma:
  1. Calls list_saved_domains() → sees "google.com" is saved
  2. Calls load_browser_cookies("google.com")
  3. Calls browser_navigate("https://search.google.com/search-console")
  4. Already authenticated, proceeds to scrape data
```

**Cookie Expiry Handling:**
```
Emma:
  1. Loads cookies and navigates to site
  2. Detects login page (cookies expired)
  3. Calls clear_browser_cookies("google.com")
  4. Asks user to login again
  5. After login, calls save_browser_cookies("google.com")
```

### 5. Security Considerations

**User Isolation:**
- Cookies are stored per-user (userId as partition key)
- DynamoDB queries are always scoped to the authenticated user
- No cross-user cookie access possible

**Session Isolation:**
- Each chat session has separate browser instance
- Cookies are loaded on-demand per session
- Closing a session doesn't affect saved cookies

**Cookie Expiry:**
- Playwright's cookie format includes `expires` field
- Expired cookies are automatically ignored by browsers
- Users can clear stale cookies via `clear_browser_cookies`

**No Encryption:**
- Cookies are already session-specific tokens
- They expire naturally
- No sensitive credentials stored (just session tokens)
- DynamoDB is already secured via IAM

### 6. LLM Guidance

Add to Emma's system prompt:
```markdown
## Browser Automation with Login Persistence

When accessing websites that require authentication:
1. Check if you have saved cookies: `list_saved_domains()`
2. If cookies exist, load them: `load_browser_cookies("example.com")`
3. Navigate to the website
4. If you see a login page (cookies expired):
   - Clear old cookies: `clear_browser_cookies("example.com")`
   - Ask the user to login
   - After successful login, save cookies: `save_browser_cookies("example.com")`

Always save cookies after successful logins so users don't need to re-authenticate.
```

## Implementation Phases

### Phase 1: Storage Layer
- Create DynamoDB table schema
- Implement CRUD operations in `db.ts`
- Add table creation to `create-tables.ts`

### Phase 2: Cookie Tools
- Implement `save_browser_cookies` tool
- Implement `load_browser_cookies` tool
- Implement `list_saved_domains` tool
- Implement `clear_browser_cookies` tool
- Register tools in Emma's tool registry

### Phase 3: Integration
- Update Emma's system prompt with browser usage guidance
- Test login flows with common sites (Google, LinkedIn, etc.)
- Handle edge cases (expired cookies, invalid cookies, etc.)

### Phase 4: Testing & Documentation
- Write unit tests for cookie storage
- Write integration tests for cookie persistence
- Document usage in CLAUDE.md
- Add troubleshooting guide

## Open Questions

1. **Cookie domain normalization**: Should we normalize domains (remove "www.", subdomains)?
   - **Decision**: Store cookies exactly as returned by Playwright (preserves domain/subdomain specificity)

2. **Cookie size limits**: DynamoDB has 400KB item size limit. What if a site has many cookies?
   - **Risk**: Low (typical cookie set is <10KB)
   - **Mitigation**: Add validation to warn if cookie size exceeds 100KB

3. **Automatic login detection**: How does Emma know when login is required?
   - **Approach**: Emma uses visual inspection (URL patterns, page content) to detect login pages
   - **Fallback**: User can manually trigger re-login via `clear_browser_cookies`

4. **Multi-account support**: What if users want separate logins for personal vs company accounts?
   - **Future enhancement**: Add optional `accountLabel` parameter to save/load cookies
   - **v1**: Single login per domain (most common use case)

## Alternatives Considered

### Alternative 1: Store cookies in S3
**Pros**: Unlimited size, cheaper for large volumes
**Cons**: Slower access, more complex querying, no native TTL
**Decision**: DynamoDB is better for fast key-value access

### Alternative 2: Store browser profile directories
**Pros**: Preserves all browser state (not just cookies)
**Cons**: Large storage size, complex to manage, harder to inspect
**Decision**: Cookies-only approach is simpler and sufficient

### Alternative 3: Per-session cookie persistence (SessionStorage-like)
**Pros**: Simpler implementation, no database needed
**Cons**: Cookies lost when session ends, defeats the purpose
**Decision**: Cross-session persistence is a core requirement

## Success Metrics

- Users can login once and reuse cookies across sessions
- Emma can access authenticated pages without manual intervention
- Cookie expiry is handled gracefully (re-login prompts)
- No cross-user cookie leakage (security validation)

## Next Steps

1. Review and approve this design
2. Create DynamoDB table schema
3. Implement cookie storage operations
4. Build Emma tools for cookie management
5. Test with real login flows
6. Document and deploy
