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
  an outside agent write arbitrary keys into the account record). Blank text (empty, spaces, or only invisible characters) means "not given" and never blanks a stored value; an empty list changes
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
- **read:** the competitor list comes back one page at a time (about 12,000 characters of compact JSON of competitors per page, at least one entry; the answer is pretty-printed, which makes the text a client receives larger: about
  1.04 times for large entries and up to about 2.7 times for very short ones); `totalCompetitors` is
  the true count and `nextCompetitorOffset` (null on the last page) says where the next page starts; an offset past the end (including one too big to be
  exact) lands on the last entry rather than an empty page. `competitorNames` (up to 50) answers stored / not stored with the offset, whatever the page
  shows; names past 50 are reported as not checked. A roster that fits one page reads as before, with the extra paging fields. The overview and ICPs are
  returned whole, as before. An answer from the route that is not a success carrying a strategy is an error, not an empty strategy.
- **who may write:** unchanged and still the route's job: an org member needs the same editor rights as in the app (403 otherwise) for a call that changes
  something. A call that changes nothing makes no write at all, so it is answered (`changed: false`) without the route's editor check; the caller can read
  everything such an answer tells it. Isolation of which strategy is the caller's is the route's (tests: `mcp.twoTenantIsolation.test.ts`,
  `mcp.manageStrategy.writes.test.ts`).
- **parallel calls:** calls on one ACCOUNT are serialized, in the order their account lookups finish, within the server process (the same locking mechanism as `manage_leads`, with its own keys; the key is the org
  when the caller belongs to one, else the user, because an org's strategy is shared by its members), since the merge is read, merge, write: two calls sent
  together (one agent's parallel calls, or the owner's agent and an editor's) would each merge onto the same stored lists and the second write would drop the
  first one's entries.
- **the merge baseline is checked, not trusted:** the route's read must be a success carrying a strategy object, else nothing is changed; stored lists that
  are not lists are refused instead of being treated as empty; a read that shows nothing stored (no `createdAt`) is read once more 200 ms later before it is
  believed, because the route's read can miss the org owner's record for a moment and a write built on that would replace the real lists; and a read whose
  `updatedAt` is older than the strategy this process saved for that account within the last minute is not used (the saved copy is), because the route's read is
  eventually consistent (solo users through an index, org callers through a plain read of the org record) and the next call of a serialized pair starts right
  after the first one's write.
- **an org caller is never merged onto a personal strategy:** the route's read answers with the org's strategy (`isOrgLevel` true) or, when its read of the org
  misses, with the caller's personal one. If the caller belongs to an org and the answer is not the org's, the call is refused ("the organisation's market
  strategy could not be read ... Nothing was changed"). The account lookup's own error text (it can name roles and tables) goes to the log, not to the caller.
- **parts the route would fill from its own read:** the tool sends the route only the parts a call changes (so a no-change part does not stamp `icpUpdatedAt`),
  and for every part it does not send the route fills the value from its OWN read of the account, which can be older than a save made a moment ago and would
  write that older part back over the saved one (the second independent review reproduced this: a competitors save followed straight away by an
  overview-only call lost the new competitor). So a part that a save of the last minute changed is sent again by the next call from the checked baseline,
  whatever that call changes. A part counts for one minute from the save that changed it; parts a later call merely carried along do not start a new minute, so
  the memory does not chain (a call 40 s after an `icp` save carries `icp`; one 80 s after it does not). The cost: a call within a minute of a save that
  changed `icp` sends `icp` again and stamps `icpUpdatedAt` again, which that earlier save had already done.

**Behaviour changes for outside callers (stated, not hidden):** a call that sent `competitors` or `icp` used to REPLACE the stored list and now merges;
sending `[]` used to wipe the list and now changes nothing (to remove entries, use the app, or `regenerate_market_strategy` through Emma); the three
never-stored arguments, every other argument the action does not take, and unknown entry fields are refused where they used to be ignored or stored; a very
large roster is paged on read. A competitor or ICP SENT as a bare string (the old schema was a bare array, so `["HubSpot"]` was plausible) is refused: an entry
is an object with a name or title. A bare string already STORED (older data; Emma's lookup reads such entries as names) is matched by its text and becomes an
entry holding that name when an update names it (it is not duplicated). `null` for any argument is the same as not sent, refused ones included. Overview, names, descriptions and personas are stored trimmed, and a name loses invisible characters (zero-width spaces and
joiners, word joiner, byte-order mark, soft hyphen; other look-alikes, such as other invisible marks, full-width letters or differently composed accents, are
not folded and still make a second entry); when two stored entries
differ only by case or spacing, the one with the exact spelling is the one updated. Every update does at least one extra read of the strategy, and one more
after a 200 ms wait when the read shows no `createdAt` (older strategies). Stored lists that are not lists block only an update of that list. The answer of an
update changed shape: it used to be `{success, data: <the whole saved strategy>, message}` and is now `{success, changed, businessOverview?, competitors?,
icp?}` with added / updated / unchanged names and the saved totals (no `data`; a call that changes nothing also carries a `message`). A blank `businessOverview` used to clear the overview; it is now "not given": refused as "nothing to send" when it is the only content, and otherwise
dropped (the answer has no `businessOverview` key), so the overview can no longer be cleared over MCP. Any `action` other than `read` or `update` (case ignored) used to be taken
as an update, so a mistyped "Read" wrote; it is now refused. A field shown when an entry is read (such as the ICP's `extractedFilters`) cannot be sent back:
it is refused with a hint to leave it out (it is kept for you).

**Differences from Emma that are not obvious:** Emma also fills empty brand fields from the strategy after each write (`populateEmptyBrandGuidelines`); the
route does not, so this tool does not. The route rebuilds the stored strategy from its six known keys (`businessOverview`, `competitors`, `icp`, `createdAt`,
`updatedAt`, `icpUpdatedAt`); Emma's merge keeps any other top-level key the record happens to hold, so for such a stray key the route's replace is not a
no-op. Emma's merge matches names exactly (only its lookup ignores case); Emma floors a fractional read offset and clamps a negative one where this tool
refuses them; Emma stamps `icpUpdatedAt` on any `icp` argument, including one that changes nothing; Emma's update answers with the saved `marketData`, and its read answers with formatted text and paging fields.

**Limits (stated):** (0) An admin's `client_id` is ignored (and listed in `ignoredArguments`): the tool has never supported client scoping, so an admin who
means a client's account gets a write on their own account, with only that note to catch it; other tools refuse `client_id`, but the two-tenant isolation tests
pin this tool's ignoring it. The lock is held across up to two reads and one write (each may take minutes if the route stalls), so a stalled call holds that
account's queue. The caller's record is read consistently to find the org; if that cannot be done the call is refused ("the account could not be
identified, so nothing was changed") rather than locked per user, which would not serialize the org's members. The recent-save memory keeps at most 100 accounts, each entry the route's whole saved strategy (up to the size of the stored strategy: the 250,000-byte limit stops growth, but an account already over it can still
be edited, up to the 400 KB record), until a minute passes and a later
save of any account sweeps it. (1a) If the consistent lookup says the caller has no org while the route's own, eventually consistent read still says there is one (a user who just left an org), the
write lands in the org's strategy under a per-user lock that does not serialize with the org's other members; the reverse (lookup says org, route says
personal) is refused. A read right after an update can show the older copy: `read` takes no lock and does not use the recent-save memory. (1) The lock and the
recent-save memory cover one server process. Calls that reach different instances, or a write by the portal or by
Emma (neither is serialized with this tool) landing between our read and our write, can still be overwritten by the merged lists we send, and a read that is
older than another writer's save (not ours) cannot be recognised here; a writer that stamps `updatedAt` with an older time than our last save (the onboarding ICP
mirror stamps its completion time, and instances' clocks can differ) is not recognised either, so such a write made within a minute of our save can be
overwritten by our next `icp` update. The read's answer is bounded for competitors only: the overview and the ICPs (with their cached filters) come back whole,
as before, and the 250,000-byte limit applies to writes only. A read of an account whose stored competitors are not a list answers with a `warning` and
no competitors instead of an error. The portal's own partial saves have the same read-then-write shape but are
human-paced; here the same read lag can hit calls made back to back, which is why the recent-save check exists. (2) The merge baseline is the route's own
read. If it degrades (the org owner's record is not yet visible) it returns an empty strategy while the route's write path fails closed on the same miss;
the second read 200 ms later makes it unlikely that both reads of one call miss, not impossible, and a write built on two missed reads replaces the lists
and masks the owner's copy. (3) `emma_send_message` with the same key still reaches Emma's own `update_market_strategy`; this PR does not change that.

**Agent mode.** `manage_market_strategy` was registered for MCP callers only (`mcpToolRegistry`); agent mode copies its tools from Emma's registry (`emmaToolRegistry`), so a private skill that listed it offered nothing and a call answered `Unknown tool: manage_market_strategy` (Opslane's AC1 on `e22f517` drove it that way). It is now bridged into Emma's registry (`bridgedToolNames` in `emma/tools.ts`, the list that already carries `resolve_skill`, `get_account_status` and the scheduled-chat tools), with the same definition and the same code, so a skill that lists it works. **Who is offered it:** a session whose installed skill lists it (private or published), provided the user's tier entitles that skill (a skill's tools are added only for a wildcard tier or a tier that lists the skill). It is not a foundation tool and it is kept out of the `__other_skills__` catch-all pool (`SKILL_ONLY_TOOL_NAMES` in `emma/impl/misc.ts`; the independent review of the first bridge head found it landed in that pool), so a session without such a skill is not offered it, and a work plan or schedule that names it in `requiredFunctionCalls` does not get it from the pool either. Sessions that are not skill-filtered still get it, as they get Emma's own `update_market_strategy`: sessions that predate skill gating (`associatedSkills` unset) and live voice sessions (`getFilteredTools` with no skill filter), on a wildcard tier. "Not offered" means not in the tool list: a call by name in a session with no installed skill is not refused at dispatch (true of every tool). Emma's `update_market_strategy` is unchanged and still a foundation tool. **Account:** the bridged copy is marked `requiresUserAccount`, so an anonymous (not signed-in) session gets the same deferred refusal as Emma's own account tools instead of the tool's lookup error. The flag is set for this tool only: none of the other 25 bridged tools' MCP handlers sets it today, so carrying every handler's flag would change nothing now, and naming the tool keeps a later handler's flag from silently changing in-app behaviour. **Restricted principals:** a share-link visitor's profile is a deny-list that does not name `update_market_strategy`, so a visitor could already write the owner's strategy through Emma's tool; this tool is no broader (it cannot remove an entry and it refuses unknown fields). **Limits (stated):** (a) the per-account lock lives in the process that runs the call. Typed-chat turns run in a forked worker, so they are serialized with each other but not with `POST /mcp`, which runs in the server process; the Emma widget (`generateChatResponse`) and live voice run in the server process and do share the lock with MCP calls. Emma's own `update_market_strategy` takes no lock at all; (b) a write through this tool does not emit the page-refresh invalidation Emma's tool emits in an `emma-sidebar` session, so a Market Strategy page open beside such a session can show the old lists until reloaded (the page saves by replacing the lists); (c) Emma's tool has a guard for a superseded brand-build session that this tool does not carry (a brand-build session is not offered it unless a skill lists it); (d) the tool name's `manage_` prefix classifies it as an `admin`-effect tool for the agent tool gateway and the plan route, for a read as well as an update, as with the other `manage_*` tools; (e) in agent mode the typed `competitors` items make a competitor sent as a bare string fail the argument contract before the tool runs (the tool refuses it too). Proof: `backend/src/__tests__/emma.manageStrategyBridge.test.ts`.

Proof: `backend/src/__tests__/mcp.manageStrategy.writes.test.ts` runs the real path (MCP client, MCP server, tool, mcpFetch, the real Express app, db.ts,
in-memory DynamoDB; strongly consistent, so the read-lag cases are simulated by answering one read with an older copy) for an org owner, a member who is not
an editor, a listed editor, another tenant and a solo user.
