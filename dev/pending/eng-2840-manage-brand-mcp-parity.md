## ENG-2840: manage_brand over MCP can set tagline, domain, brand values, personality and founders; founders merge by name and are removed only by name (2026-11-20)

`manage_brand` mapped six fields onto `POST /api/brand/guidelines`. That route also stores the tagline, the domain, the brand values, the brand
personality and the founder profiles, which Emma's `update_brand_guidelines` writes, so an outside agent could not set them. The tool now can
(`backend/src/mcp/server/manageBrandWrites.ts`). The REST route is unchanged, so the customer portal behaves as before. `read` returns what it did, except
that an argument it does not take is refused by name.

- **new fields:** `tagline` (300 characters), `domain` (253), `brand_personality` (2,000) and `brand_values` (a list of up to 50, 200 characters each,
  trimmed, blank entries dropped). They replace the stored value, like `key_messages` always did. For these new fields (and for founders) blank text (empty, spaces, or
  only invisible characters; text that merely contains a joiner, as an emoji does, is kept as sent) and an empty list mean "not given" and never blank a stored value. The six fields the tool always had (`company_name`, `mission`, `tone_of_voice`,
  `target_audience`, `key_messages`, `visual_identity`) keep their mapping and behaviour exactly, including the fact that they are forwarded as sent and are
  not validated: an explicit blank (or `null`, or a very large value) there is stored as sent, as it always was.
- **founders merge by name (a deliberate difference from Emma).** The route REPLACES the stored founder list (an empty list wipes it). Emma treats a
  non-empty list as the complete roster: a stored founder it leaves out is removed (ENG-2875). Emma and the portal hold the whole roster; an outside agent
  that sends one founder does not, and under Emma's rule it would delete the others. So over MCP `founders` merges: a stored founder with the same name
  (case, padding, repeated spaces, invisible characters (every Unicode format character, the variation selectors, the blank braille pattern and the combining grapheme joiner) and the way an accent is encoded ignored) is updated field by field and keeps its own spelling and every field the caller did not
  send, a new name is added, and a founder nobody mentions is kept. If older data holds the same founder twice, an update lays the new fields over every
  copy and a removal drops every copy. An empty list changes nothing (Emma ignores it too). Omission never removes anyone. The same founder twice in one call is refused. A founder holds `name`,
  `jobTitle`, `styleTone`, `signaturePosts` and `voiceExamples` (text, bounded: 200 / 2,000 / 10,000 / 20,000 characters); other fields are refused by
  name. At most 20 per call; a call that would take the roster past 50 founders, or the founder profiles past 250,000 bytes together (the founder profiles are one part of the brand record, which also holds the rest of the brand and, for a solo user, the whole user record in one DynamoDB item of at
  most 400 KB; the cap keeps the roster from taking the record by itself, it does not guarantee that the record fits, and a save that does not fit comes back from
  the route as an unexplained 500), is refused when it makes them bigger; a roster already over that size can still edit an entry as long as the edit does not
  make it bigger.
- **removal is deliberate: `remove_founders: [names]`** removes the founders with those names (matched the same way as the merge; at most 20 names per call,
  200 characters each). The answer says which were removed and which were not found. A name in both `founders` and `remove_founders` is refused. This is the
  `removeFounders` shape the ENG-2875 card itself names as the alternative to an authoritative list. (Decided by the owner on 2026-11-19 after weighing Emma's
  rule, additive-only without removal, and a `replace_founders` flag.)
- **arguments an update does not take are refused by name** (for example `logo_url` or `brandName`): they would be dropped while the call reported success.
  Identity-style arguments are not refused: the brand is always the caller's own and, for outside callers, they are never used. `client_id`, `clientId` and
  `user_id` are listed in `ignoredArguments`; `userId` is removed by the MCP layer before a tool sees it (so it is not listed, and for internal callers it
  selects the account). An admin who sends a client's id therefore writes to
  their own account, with only that note to catch it (other tools refuse `client_id`; the two-tenant isolation tests pin this tool's ignoring it). `read` takes
  no arguments and refuses any other the same way.
- **honest answers:** the route answers a save with a message only, so after a founder change the founders are read back and the answer reports the stored
  total and what was changed (added, updated, unchanged, removed, not found: these describe the intended outcome; only `total` comes from the read). The
  read-back compares each founder's name and the four text fields this tool writes, in order; a read that does not match is repeated once after 300 ms (the
  org read is eventually consistent, so it can be older than the save) before the answer is a failure ("could not be verified on read-back": the save itself
  went through, the route answered). If the read-back fails outright, the answer is a failure saying the brand was saved but could not be read back. A call
  that changes nothing in the founders and sends nothing else (a founder already stored exactly as sent, a name that is not stored) writes nothing; a call that
  sends scalar fields always saves, even if a value equals the stored one (the route bumps `updatedAt`), and `changed: true` there means "saved", not
  "different". A call with nothing to change is refused instead of reported as saved.
- **who may write:** unchanged and still the route's job: an org member needs the same brand-editor rights as in the app (403 otherwise) for a call that changes
  something. A call that changes nothing makes no write at all, so it is answered (`changed: false`) without the route's editor check; the caller can read
  everything such an answer tells it. The route saves with
  an optimistic version check against what it read inside the same request, so a save that lands while the route is saving ours makes ours fail with its
  "being updated, try again" message (409) and nothing changes (see the limits for what that check does not cover).
- **parallel calls:** calls on one ACCOUNT are serialized, in the order their account lookups finish, within the server process (the lock the lead tools use; the key is the org when the
  caller belongs to one, else the user, because an org's brand is shared by its members): the founder merge is read, merge, write, so two calls sent together
  (one agent's parallel calls, or the owner's agent and an editor's) would each merge onto the same list and the second save would drop the first one's
  founder. The caller's record is read consistently to find the org; if that cannot be done the call is refused ("the account could not be identified, so
  nothing was changed") rather than locked per user, which would not serialize the org's members. A call waits for the calls ahead of it with no timeout of
  its own (each read or write the route does can take up to five minutes if it stalls).
- **the merge baseline is checked, not trusted:** the route's read must answer `exists` true with brand data, or `exists` false, else nothing is changed; a
  read that shows no brand is read once more 200 ms later before it is believed, because the route's read can miss the org owner's record for a moment and a
  founder list built on that would replace the stored founders; and a read whose `updatedAt` is older than the brand this process saved for that account
  within the last minute is not used (the roster it saved is), because the next call of a serialized pair starts right after the first one's save. The roster
  that a save meant is remembered even when its own read-back came back older than the save, which is when the next call needs it most. The memory keeps at
  most 100 accounts for a minute each and is swept whenever a founder save is read back.

**Behaviour changes for outside callers (stated, not hidden):** a call with no field to change used to post an empty body, which the route saves ("saved
successfully", `updatedAt` moves, an account with no brand gets an empty record and its brand-build status flips to ready); it is now refused. Any `action`
other than `read` or `update` (case ignored) used to be taken as an update, so a mistyped "Read" wrote; it is now refused. Arguments the update does not take
(anything outside the tool's own fields) used to be ignored and are now refused by name; so are arguments given to `read`, and keys inside `visual_identity`
that the brand does not store (`visual_identity` takes `primaryColor`, `primaryColorEnd`, `secondaryColor`, `fontFamily` and `isGradient`; it must be an
object). The answer of a successful update
now carries `success`, `changed`, `ignoredArguments` when any, and after a founder change the founders section; the route's own `message` and `attachments`
fields are still there (its `debug` field is removed from answers to outside callers by the public response sanitiser, as before). Every update now reads the
caller's record to find the account, and an update with founders reads the brand once or twice before and once or twice after the save.

**Limits (stated):** (1) the lock and the recent-save memory cover one server process; calls that reach different instances are not serialized, and a founder
change made between our read and our write (by the portal, Emma or another session) can be overwritten by the merged list we send. The route's version check
covers a save that lands inside its own read-and-write, not ours. A read that is older than another writer's save (not ours) cannot be recognised here.
(1b) If the route's read misses the org owner's record twice in a row (the second read is 200 ms after the first), a founder list built on it replaces the
stored founders and masks the owner's copy. (2) Logos and brand assets are not writable here (they need a file upload route), and the brand-guide link
(`brandGuideUrl`, which the route does accept as JSON) is not forwarded. (3) Emma's `emma_send_message` with the same key still reaches Emma's own
`update_brand_guidelines` with its authoritative founder list; this PR does not change that. (4) A founder update that is lost without changing any name or
text this tool writes cannot be told from success; the read-back compares what this tool writes, in order. (5) The remembered roster is compared with a read
by timestamp (the route's `updatedAt` against this process's clock): a portal edit within a minute that carries an older stamp, as a skewed clock on another
instance could give, is overwritten by the remembered roster. (6) A read-back that fails or does not match is answered as an ordinary tool result with
`success: false` (`isError` is false), because the save went through; a client that looks only at `isError` reads it as success.

Proof: `backend/src/__tests__/mcp.manageBrand.writes.test.ts` runs the real path (MCP client, MCP server, tool, mcpFetch, the real Express app, db.ts,
in-memory DynamoDB; strongly consistent, so the read-lag cases are simulated by answering a read with an older copy) for an org owner, a member who is not an
editor, a listed editor, another tenant and a solo user.
