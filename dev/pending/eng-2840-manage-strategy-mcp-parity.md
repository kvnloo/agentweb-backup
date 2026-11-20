## ENG-2840: manage_market_strategy over MCP merges like Emma instead of replacing, and the read pages (2026-11-20)

`manage_market_strategy` used to forward its arguments to `POST /api/market-strategy`. That route reads only `businessOverview`, `competitors` and `icp`,
and it REPLACES the stored competitor and ICP lists with the lists it is given. So an outside agent that sent one new competitor deleted all the others,
and the three other arguments the tool advertised (`positioning`, `differentiators`, `channels`) were dropped without a word. Emma's own
`update_market_strategy` reads the strategy first and merges competitors by name and ICPs by title. The MCP tool now does the same
(`backend/src/mcp/server/manageStrategyWrites.ts`). The REST route is unchanged, so the customer portal behaves as before: its replace is harmless
for the lists the tool hands it, because they are already the merged ones.

- **update:** the stored strategy is read first. Competitors merge by name and ICPs by title (case, padding and repeated spaces ignored; Emma's own stored /
  not-stored lookup ignores case and padding); an entry that is already stored is updated field by field and keeps its own spelling of the name; every other
  stored entry is kept, including fields the tool cannot write (the ICP's cached search filters). Nothing can be removed (Emma has no removal either;
  `regenerate_market_strategy` is the separate destructive tool). The answer lists what was added, updated and unchanged per list, and the totals are the
  ones the route reports as saved.
- **what is accepted:** a competitor holds `name` and `description`; an ICP holds `title`, `description`, `valueProposition` and `buyerPersonas` (a list of
  text that replaces that profile's list). Any other field is refused by name (Emma spreads any extra key onto the stored strategy; over MCP that would let
  an outside agent write arbitrary keys into the account record). Blank text means "not given" and never blanks a stored value; an empty list changes
  nothing. At most 100 entries per list per call; a name or title of 200 characters, text of 5,000, a persona of 500 (50 per profile), an overview of
  20,000. A merge that would take a list past 500 competitors or 100 ICPs is refused when it adds an entry, and so is one that would take the overview and
  both lists past 250,000 bytes together: the strategy sits on the account record, one DynamoDB item of at most 400 KB that also holds everything else of
  the account, so an oversized save is refused here with a reason instead of coming back from the route as an unexplained 500. An account that is already
  over that size can still edit an entry as long as the edit does not make it bigger.
- **refused by name:** `positioning`, `differentiators` and `channels` (never stored: callers believed they were saved), and any other top-level argument
  the action does not take (for example `targetAudience` on an update, or `competitors` on a read): it would be dropped while the call reported success
  (found by the Opslane check on the first head). Identity-style arguments (`client_id`, `clientId`, `user_id`, `userId`) are not refused: the strategy is
  always the caller's own and they are never used (the MCP layer already strips `userId` before a tool sees it), and the answer lists them in
  `ignoredArguments`. A call with nothing to send is refused instead of reported as saved. One bad entry refuses the whole call; nothing is half-saved.
- **a call that changes nothing writes nothing.** A write that carries `icp` marks the ICPs as hand-edited, which switches the account off its cached ICP
  search filters (`icpUpdatedAt`), so repeating what is already stored must not do that. Stored text is compared trimmed, so stored padding does not make a
  repeat look like a change. Only the parts that changed are sent to the route.
- **read:** the competitor list comes back one page at a time (about 12,000 characters of competitors per page, at least one entry); `totalCompetitors` is
  the true count and `nextCompetitorOffset` (null on the last page) says where the next page starts; an offset past the end (including one too big to be
  exact) lands on the last entry rather than an empty page. `competitorNames` (up to 50) answers stored / not stored with the offset, whatever the page
  shows; names past 50 are reported as not checked. A roster that fits one page reads as before, with the extra paging fields. The overview and ICPs are
  returned whole, as before. An answer from the route that is not a success carrying a strategy is an error, not an empty strategy.
- **who may write:** unchanged and still the route's job: an org member needs the same editor rights as in the app (403 otherwise). Isolation of which
  strategy is the caller's is the route's (tests: `mcp.twoTenantIsolation.test.ts`, `mcp.manageStrategy.writes.test.ts`).
- **parallel calls:** calls on one ACCOUNT are serialized in arrival order within the server process (the same lock as `manage_leads`; the key is the org
  when the caller belongs to one, else the user, because an org's strategy is shared by its members), since the merge is read, merge, write: two calls sent
  together (one agent's parallel calls, or the owner's agent and an editor's) would each merge onto the same stored lists and the second write would drop the
  first one's entries.
- **the merge baseline is checked, not trusted:** the route's read must be a success carrying a strategy object, else nothing is changed; stored lists that
  are not lists are refused instead of being treated as empty; a read that shows nothing stored (no `createdAt`) is read once more 200 ms later before it is
  believed, because the route's read can miss the org owner's record for a moment and a write built on that would replace the real lists; and a read whose
  `updatedAt` is older than the strategy this process saved for that account within the last minute is not used (the saved copy is), because the route reads
  through an eventually consistent index and the next call of a serialized pair starts right after the first one's write.

**Behaviour changes for outside callers (stated, not hidden):** a call that sent `competitors` or `icp` used to REPLACE the stored list and now merges;
sending `[]` used to wipe the list and now changes nothing (to remove entries, use the app, or `regenerate_market_strategy` through Emma); the three
never-stored arguments, every other argument the action does not take, and unknown entry fields are refused where they used to be ignored or stored; a very
large roster is paged on read. The answer of an
update changed shape: it used to be `{success, data: <the whole saved strategy>, message}` and is now `{success, changed, businessOverview?, competitors?,
icp?}` with added / updated / unchanged names and the saved totals (no `data`, no `message`). A blank `businessOverview` used to clear the overview and is
now refused as "nothing to send" (the overview can no longer be cleared over MCP). Any `action` other than `read` or `update` (case ignored) used to be taken
as an update, so a mistyped "Read" wrote; it is now refused. A field shown when an entry is read (such as the ICP's `extractedFilters`) cannot be sent back:
it is refused with a hint to leave it out (it is kept for you).

**Differences from Emma that are not obvious:** Emma also fills empty brand fields from the strategy after each write (`populateEmptyBrandGuidelines`); the
route does not, so this tool does not. The route rebuilds the stored strategy from its six known keys (`businessOverview`, `competitors`, `icp`, `createdAt`,
`updatedAt`, `icpUpdatedAt`); Emma's merge keeps any other top-level key the record happens to hold, so for such a stray key the route's replace is not a
no-op.

**Limits (stated):** (1) The lock and the recent-save memory cover one server process. Calls that reach different instances, or a write by the portal or by
Emma (neither is serialized with this tool) landing between our read and our write, can still be overwritten by the merged lists we send, and a read that is
older than another writer's save (not ours) cannot be recognised here. The portal's own partial saves have the same read-then-write shape but are
human-paced; here the same read lag can hit calls made back to back, which is why the recent-save check exists. (2) The merge baseline is the route's own
read. If it degrades (the org owner's record is not yet visible) it returns an empty strategy while the route's write path fails closed on the same miss;
the second read 200 ms later makes it unlikely that both reads of one call miss, not impossible, and a write built on two missed reads replaces the lists
and masks the owner's copy. (3) `emma_send_message` with the same key still reaches Emma's own `update_market_strategy`; this PR does not change that.

Proof: `backend/src/__tests__/mcp.manageStrategy.writes.test.ts` runs the real path (MCP client, MCP server, tool, mcpFetch, the real Express app, db.ts,
in-memory DynamoDB; strongly consistent, so the read-lag cases are simulated by answering one read with an older copy) for an org owner, a member who is not
an editor, a listed editor, another tenant and a solo user.
