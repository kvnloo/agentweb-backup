## ENG-2840: memory tools on the MCP server (save, delete, list; org writes behind a new scope), plus a mint-time rate check and batch counting (2026-11-23)

Wave 2, slice 2. Outside agents (the Hermes agents) can now keep Emma's memory over MCP. No table, index, stored attribute or migration changes.

### What an agent gets

- `save_memory`, `delete_memory`, `list_memories`: the user's own memory. Default scopes (`tools:execute` to write, `tools:read` to list); a signed-in OAuth client may use them too.
- `save_org_memory`, `delete_org_memory`: the organization's memory, which goes into EVERY member's Emma prompt. They need the new opt-in scope `memory:org` and an `aw_` key (`apiKeyOnly`): an OAuth client is refused, and `tools:execute` does not imply the scope. A delegated (admin-as-customer) session cannot mint a key with it. Any org member's key may write; owners and admins (`org:configure`) may delete.
- Reading org memory needs no opt-in scope: `list_memories` with `scope: "org"` shows a member what Emma already shows them.
- The tools run in process on the shared module from W2-1, so the guards are Emma's: identity from the key (never an argument), memory switched off, no org, org memory off, the role check on delete, content over 2,000 characters split and over 8,000 refused, ads-learning rows never deleted or listed.

### What the MCP path adds (Emma's own tools and the Settings routes are unchanged)

- The MCP path validates nothing against the input schema, so each handler checks its own arguments. An argument that is not an input of the tool is refused by name ("orgId is not an input of save_org_memory"), never ignored. (The server itself drops `userId`, `sessionId` and `llmModel` before any tool sees them, so those run as the caller.)
- A cap of 200 stored memories per account and per org on saves made through MCP. A split save counts its rows. An account already above 200 (the largest on prod stores 277) keeps everything and is refused new saves until it deletes. The cap is a soft bound: two saves at the same instant can overshoot it by one call.
- An exact duplicate (same category, same text, ignoring surrounding whitespace) is not written again and costs no embedding; the answer says `saved: false, duplicate: true` and names the existing id. Split saves skip this check.
- `list_memories` (new): newest first, 20 a page (1 to 50), `nextCursor` back as `cursor`. The page is cut from the bounded newest-1,000 read the Settings screens make, by memory id, so a cursor can only ever select rows of the caller's own account or org. Never returns embeddings; says `truncated` when older rows exist. Both the list and the cap/duplicate check read the table strongly consistently (new `consistentRead` option on the two memory readers), so a list right after a save shows it and two identical saves in a row see each other; a category is filtered in code because an index cannot be read consistently.

### Two small fixes that ride along

- `POST /api/agent/api-keys` validated nothing about `rateLimitPerMin`, and the limiter trusts it: a key minted with a huge, negative or text rate had no effective limit. It must now be a whole number from 1 to 600 (missing or null means the default 60). Nothing existing changes: prod has 66 keys, 61 at 60 and 5 at 10.
- The limiter counted HTTP requests, so a JSON-RPC batch of 100 calls cost one count. The other members are now charged, for aw_ keys and OAuth users alike; a batch that does not fit in what is left is refused whole (429) before any member runs.

### Limits, stated

- Org memory is written into every member's prompt: a key holding `memory:org` can put text in front of every member's Emma. That is why the scope is opt-in and key-only. The cap bounds how much.
- Outside this repo: the key broker must request `memory:org` when it mints for an agent that should write org memory; the customer portal's key form cannot grant it today.
- Memory is never deleted by age: TTL is off on both tables, and no source attribute is stored (no `source: 'mcp'` on rows; that would be a persisted-model change).
- Rollback is a revert of the PR (code only).
