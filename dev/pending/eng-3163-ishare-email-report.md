## ENG-3163: share-link report email can no longer be used as a mail relay (2026-11-20)

- **Problem:** `POST /api/agent-mode/ishare/:shareId/email-report` needs no login (a landing page calls it so a lead gets their own AI report by email). Holding a share link was enough to make AgentWeb send mail from our domain to any address, with any link behind the "View Your Report" button, as often as the caller liked. That is a spam and phishing relay, and it can damage the sending reputation every customer's email depends on.
- **Kept:** the lead flow. A visitor still gets the report emailed to the address they give, and the email looks the same.
- **Changed:**
  - The report link must be on a site we run: agentweb.pro and its subdomains, subdomains of agentwebforms.com, hireemma.ai and its subdomains (the same list the API already trusts for browser calls), plus this environment's configured portal origins. Anything else is a 400. The link is also HTML-escaped where it goes into the email (before, it went into the `href` unescaped).
  - The recipient must be one plain address. Lists, "Name <address>" and line breaks are a 400.
  - Sends are limited to 3 per share link per hour, 3 per recipient address per hour, and 60 per caller IP per hour. Over the limit is a 429 with `Retry-After`. The share token and expiry checks are unchanged and still run first, so a caller with a wrong token cannot use up a real link's sends.
- **Limits are held in memory** on the one prod instance and reset when it is replaced (a deploy). They bound abuse; they are not a permanent quota.
- **Still possible:** someone holding a share link can send the standard "your report is ready" email, with a link on our own site, to an address they choose, up to the limits above.
- **Also changed:** `RateLimiter` takes an optional window length (default stays one minute, so existing callers are unchanged).
