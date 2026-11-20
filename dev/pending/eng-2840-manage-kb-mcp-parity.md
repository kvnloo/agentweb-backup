## ENG-2840: knowledge base list over MCP takes the inputs Emma's list takes (2026-11-20)

`list_knowledge_bases` sent no query at all, although the route behind it (`GET /api/emma/knowledge-bases`, `routes/emmaApi.ts`) and Emma's
`list_knowledge_base_files` take `kb_type`, `modified_after`, `modified_before`, `limit` and `offset`. The tool now takes all five
(`backend/src/mcp/server/knowledgeBaseParams.ts`). The REST routes are unchanged, so the customer portal and Emma behave as before, and no other
knowledge-base tool changes (`create_knowledge_base_file`, `update_knowledge_base_file_content`, `delete_knowledge_base_file`, `search_knowledge_base`,
`read_knowledge_base_files`). Creating a knowledge base through MCP still makes a private one only.

- **What each input does is decided by the service** (`emma/impl/knowledgeBase.ts`, `listKnowledgeBaseFiles`), and the tool says so in its description:
  - `kb_type` picks the sources. `private` and `public` both mean "only the platform knowledge bases" (the service does not tell the two apart, and the
    platform list is your own, those your organisation shares with you when org sharing is on, and the public ones: a `private` row is not necessarily
    yours). `google-drive`, `clickup`, `clickup-tasks`, `foreplay-swipefile` and `foreplay-board` mean only that connected source; the two Foreplay values
    return the same thing (the swipefile and every board). ClickUp folder entries are listed whatever `kb_type` is (the service has no guard there).
  - `modified_after`, `modified_before`, `limit` (default 100) and `offset` apply to the Google Drive files only; they have no effect on the platform
    knowledge bases, ClickUp or Foreplay (the answer's message still echoes them). `limit` and `offset` apply per Google Drive source (a registered folder
    with everything under it), so paging Drive files repeats the other sources on every page; send `kb_type: google-drive` to page Drive alone (ClickUp folder
    entries still come with it).
- **Validated before anything is sent, refused by name:** `kb_type` must be one of the seven kinds (case and padding ignored); the dates must be calendar dates
  in `YYYY-MM-DD` form (the only form the service accepts; a date with a time, or a date that does not exist, is refused here instead of coming back from the
  service as a failure), and `modified_after` must not be later than `modified_before` (no file could match); `limit` (1 to 1,000) and `offset` (0 to 100,000)
  must be whole numbers, as a number or as digits in text. Empty, blank and 0 mean "not given", so 0 means the default, not "none" (the service would take a
  limit of 0 literally and return no file). The bounds are the tool's: the service has none, and an unbounded value makes it walk a whole Drive folder on the
  shared service account. With no arguments the call is exactly what it was.

**Behaviour changes for outside callers:** none for a call that sends no argument. A call that sent one of these arguments used to have it dropped (the tool
never forwarded it); it is now forwarded, or refused by name when it cannot be understood.

**Limits (stated):** (1) The no-argument answer includes the public knowledge bases of other users and, when org sharing is on, teammates' private ones, as it
always did. (2) `foreplay-swipefile` and `foreplay-board` fetch the same things. (3) The tests run the tool against a fake of the route; the service's handling of
each input is as read from `emma/impl/knowledgeBase.ts` (and run against a stubbed service by the independent review), not observed against live Drive, ClickUp
or Foreplay. (4) The tool is classified `write` by the annotation policy, as before, so a `tools:read` key cannot call it.

**Not in this change, on purpose:** an `append` mode for `update_knowledge_base_file_content`. A first version was built and reviewed; the review showed it
cannot be verified by the recorded file size: `knowledgeBaseSize` holds the main file's size after a main-file write but the SUM of the attachments after an
attachment write (and other writers set it their own way), so the size read before an append is wrong whenever attachments exist and a correct append is reported as
"could not be verified" (a retry then duplicates the text); a file listed in the record but missing in storage, two attachments with the same name, a
failure after the text was stored, and a racing writer give the same false answers (and an equal-length racing writer a false success); the route's append
decodes the stored bytes as UTF-8, which corrupts a Latin-1 or UTF-16 `.txt` uploaded through the portal; and rewrites of the shared file list by other
files' writes can orphan a file. A safe append needs the actual text read before and after (prefix and suffix check), one lock per knowledge base, and a
refusal for text that is not valid UTF-8; that is a separate change.

Proof: `backend/src/mcp/server/__tests__/knowledgeBaseWriteTools.test.ts` (the earlier tests unchanged and green, plus the list query tests).
