## ENG-2840: manage_market_strategy over MCP merges like Emma instead of replacing, and the read pages (2026-11-20)

`manage_market_strategy` used to forward its arguments to `POST /api/market-strategy`. That route reads only `businessOverview`, `competitors` and `icp`,
and it REPLACES the stored competitor and ICP lists with the lists it is given. So an outside agent that sent one new competitor deleted all the others,
and the three other arguments the tool advertised (`positioning`, `differentiators`, `channels`) were dropped without a word. Emma's own
`update_market_strategy` reads the strategy first and merges competitors by name and ICPs by title. The MCP tool now does the same
(`backend/src/mcp/server/manageStrategyWrites.ts`). The REST route is unchanged, so the customer portal behaves as before: its replace is harmless
because the lists the tool hands it are already the merged ones.

- **update:** the stored strategy is read first. Competitors merge by name and ICPs by title (case and padding ignored, as Emma's own stored / not-stored
  lookup does); an entry that is already stored is updated field by field and keeps its own spelling of the name; every other stored entry is kept, including
  fields the tool cannot write (the ICP's cached search filters). Nothing can be removed (Emma has no removal either; `regenerate_market_strategy` is the
  separate destructive tool). The answer lists what was added, updated and unchanged per list, and the totals are the ones the route reports as saved.
- **what is accepted:** a competitor holds `name` and `description`; an ICP holds `title`, `description`, `valueProposition` and `buyerPersonas` (a list of
  text that replaces that profile's list). Any other field is refused by name (Emma spreads any extra key onto the stored strategy; over MCP that would let
  an outside agent write arbitrary keys into the account record). Blank text means "not given" and never blanks a stored value; an empty list changes
  nothing. At most 100 entries per list per call; a name or title of 200 characters, text of 5,000, a persona of 500 (50 per profile), an overview of
  20,000. A merge that would take a list past 500 competitors or 100 ICPs is refused when it adds an entry (the account record is one DynamoDB item).
- **refused by name:** `positioning`, `differentiators` and `channels` (never stored: callers believed they were saved). A call with nothing to send is
  refused instead of reported as saved. One bad entry refuses the whole call; nothing is half-saved.
- **a call that changes nothing writes nothing.** A write that carries `icp` marks the ICPs as hand-edited, which switches the account off its cached ICP
  search filters (`icpUpdatedAt`), so a repeat of what is already stored must not do that. Only the parts that changed are sent to the route.
- **read:** the competitor list comes back one page at a time (about 12,000 characters of competitors per page, at least one entry); `totalCompetitors` is
  the true count and `nextCompetitorOffset` (null on the last page) says where the next page starts; an offset past the end lands on the last entry rather
  than an empty page. `competitorNames` (up to 50) answers stored / not stored with the offset, whatever the page shows; names past 50 are reported as not
  checked. A roster that fits one page reads as before, with the extra paging fields. The overview and ICPs are returned whole, as before.
- **who may write:** unchanged and still the route's job: an org member needs the same editor rights as in the app (403 otherwise). Isolation of which
  strategy is the caller's is the route's (tests: `mcp.twoTenantIsolation.test.ts`, `mcp.manageStrategy.writes.test.ts`).
- **parallel calls:** one agent's calls on one account are serialized in arrival order within the server process (the same lock as `manage_leads`, key
  `strategy:<user>`), because the merge is read, merge, write: two calls sent together would each merge onto the same stored lists and the second write
  would drop the first one's entries.

**Behaviour changes for outside callers (stated, not hidden):** a call that sent `competitors` or `icp` used to REPLACE the stored list and now merges;
sending `[]` used to wipe the list and now changes nothing (to remove entries, use the app, or `regenerate_market_strategy` through Emma); the three
never-stored arguments and unknown entry fields are refused where they used to be ignored or stored; a very large roster is paged on read.

**Limits (stated):** (1) the lock covers one server process; calls from different sessions on different instances, or two members of one org writing at the
same moment, are not serialized, and the route's own read of the account is eventually consistent (it reads the user through a global index), so a write
that follows another within a moment can start from a stale copy. This is the same limit the route already has for the portal's own partial saves.
(2) The merge baseline is the route's own read. If that read degrades (the org owner's record is not yet visible) it returns an empty strategy while the
route's write path fails closed on the same miss; both reads would have to disagree inside one call for a write to replace a list. (3) Emma's
`emma_send_message` with the same key still reaches Emma's own `update_market_strategy`; this PR does not change that.

Proof: `backend/src/__tests__/mcp.manageStrategy.writes.test.ts` runs the real path (MCP client, MCP server, tool, mcpFetch, the real Express app, db.ts,
in-memory DynamoDB) for an org owner, a member who is not an editor, a listed editor, another tenant and a solo user.
