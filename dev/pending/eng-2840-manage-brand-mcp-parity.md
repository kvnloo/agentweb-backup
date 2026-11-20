## ENG-2840: manage_brand over MCP can set tagline, domain, brand values, personality and founders; founders merge by name and are removed only by name (2026-11-20)

`manage_brand` mapped six fields onto `POST /api/brand/guidelines`. That route also stores the tagline, the domain, the brand values, the brand
personality and the founder profiles, which Emma's `update_brand_guidelines` writes, so an outside agent could not set them. The tool now can
(`backend/src/mcp/server/manageBrandWrites.ts`). The REST route is unchanged, so the customer portal behaves as before. `read` is unchanged.

- **new fields:** `tagline` (300 characters), `domain` (253), `brand_personality` (2,000) and `brand_values` (a list of up to 50, 200 characters each).
  They replace the stored value, like `key_messages` always did. For these new fields (and for founders) blank text and an empty list mean "not given" and
  never blank a stored value. The six fields the tool always had (`company_name`, `mission`, `tone_of_voice`, `target_audience`, `key_messages`,
  `visual_identity`) keep their mapping and behaviour exactly, including the fact that they are forwarded as sent: an explicit blank there still blanks the
  stored value, as it always did.
- **founders merge by name (a deliberate difference from Emma).** The route REPLACES the stored founder list (an empty list wipes it). Emma treats a
  non-empty list as the complete roster: a stored founder it leaves out is removed (ENG-2875). Emma and the portal hold the whole roster; an outside
  agent that sends one founder does not, and under Emma's rule it would delete the others. So over MCP `founders` merges: a stored founder with the same
  name (case and padding ignored) is updated field by field and keeps its own spelling and every field the caller did not send, a new name is added, and a
  founder nobody mentions is kept. An empty list changes nothing (Emma ignores it too). Omission never removes anyone. A founder holds `name`,
  `jobTitle`, `styleTone`, `signaturePosts` and `voiceExamples` (text, bounded: 200 / 2,000 / 10,000 / 20,000 characters); other fields are refused by
  name. At most 20 per call; a call that would take the roster past 50 is refused when it adds a founder.
- **removal is deliberate: `remove_founders: [names]`** removes exactly those founders (exact name after trimming, case ignored; at most 20 per call).
  The answer says which were removed and which were not found. A name in both `founders` and `remove_founders` is refused. This is the `removeFounders`
  shape the ENG-2875 card itself names as the alternative to an authoritative list. (Decided by the owner on 2026-11-19 after weighing Emma's rule,
  additive-only without removal, and a `replace_founders` flag.)
- **honest answers:** the route answers a save with a message only, so after a founder change the founders are read back and the answer reports what is
  stored (added, updated, unchanged, removed, not found, total). If the read-back does not match what was meant to be saved, the answer is a failure that
  says so. A call that changes nothing (a founder already stored exactly as sent, a name that is not stored) writes nothing. A call with nothing to change
  is refused instead of reported as saved.
- **who may write:** unchanged and still the route's job: an org member needs the same brand-editor rights as in the app (403 otherwise). The route
  saves with an optimistic version check against what it read inside the same request, so a save that lands while the route is saving ours makes ours
  fail with its "being updated, try again" message and nothing changes (see the limits for what that check does not cover).
- **parallel calls:** one agent's calls on one account are serialized in arrival order within the server process (the lock the lead tools use, key
  `brand:<user>`): the founder merge is read, merge, write, so two calls sent together would each merge onto the same list and the second save would drop
  the first one's founder.

**Behaviour changes for outside callers (stated, not hidden):** a call with no field to change used to post nothing and answer success; it is now refused.
The answer of a successful update now carries `success`, `changed` and, after a founder change, the founders section (the route's own `message`,
`attachments` and `debug` fields are still there).

**Limits (stated):** (1) the lock covers one server process; calls from different sessions on different instances are not serialized, and a founder change
made between our read and our write (by the portal or another session) can be overwritten by the merged list we send. The route's version check covers a
save that lands inside its own read-and-write, not ours. (2) Logos, brand assets and the brand-guide link are not writable here (they need a file upload
route). (3) Emma's `emma_send_message` with the same key still reaches Emma's own `update_brand_guidelines` with its authoritative founder list; this PR
does not change that.

Proof: `backend/src/__tests__/mcp.manageBrand.writes.test.ts` runs the real path (MCP client, MCP server, tool, mcpFetch, the real Express app, db.ts,
in-memory DynamoDB) for an org owner, a member who is not an editor, a listed editor, another tenant and a solo user.
