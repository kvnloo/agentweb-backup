## ENG-2840: knowledge base list over MCP takes the inputs Emma's list takes (2026-11-20)

`list_knowledge_bases` sent no query at all, although the route behind it (`GET /api/emma/knowledge-bases`, `routes/emmaApi.ts`) and Emma's
`list_knowledge_base_files` take `kb_type`, `modified_after`, `modified_before`, `limit` and `offset`. The tool now takes all five
(`backend/src/mcp/server/knowledgeBaseParams.ts`). The REST routes are unchanged, so the customer portal and Emma behave as before, and no other
knowledge-base tool changes (`create_knowledge_base_file`, `update_knowledge_base_file_content`, `delete_knowledge_base_file`, `search_knowledge_base`,
`read_knowledge_base_files`). Creating a knowledge base through MCP still makes a private one only.

- **What each input does is decided by the service** (`emma/impl/knowledgeBase.ts`, `listKnowledgeBaseFiles`), and the tool says so in its description:
  `kb_type` picks the sources: `private` and `public` both mean "only the platform knowledge bases" (yours and the public ones; the service does not tell the
  two apart), `google-drive`, `clickup`, `clickup-tasks`, `foreplay-swipefile` and `foreplay-board` mean only that connected source. `modified_after`,
  `modified_before`, `limit` (default 100) and `offset` apply to the Google Drive files only (`limit` and `offset` per Drive folder); they have no effect on the
  platform knowledge bases, ClickUp or Foreplay.
- **Validated before anything is sent, refused by name:** `kb_type` must be one of the seven kinds (case and padding ignored); the dates must be calendar dates
  in `YYYY-MM-DD` form (the only form the service accepts; a date with a time, or a date that does not exist, is refused here instead of coming back from the
  service as a failure); `limit` and `offset` must be whole numbers, as a number or as digits in text. Empty, blank and 0 mean "not given". With no
  arguments the call is exactly what it was.

**Behaviour changes for outside callers:** none for a call that sends no argument. A call that sent one of these arguments used to have it dropped (the tool
never forwarded it); it is now forwarded, or refused by name when it cannot be understood.

**Limits (stated):** (1) `limit` and `offset` have no upper bound here (the service has none); a very large value may make the Drive listing walk until the
service's own time limit (not observed). (2) The public knowledge bases of other users are part of the no-argument answer, as they always were. (3) The tests run the tool
against a fake of the route; the service's handling of each input is as read from `emma/impl/knowledgeBase.ts`, not observed live.

**Not in this change, on purpose:** an `append` mode for `update_knowledge_base_file_content`. A first version was built and reviewed; the review showed it
cannot be verified by the recorded file size: `knowledgeBaseSize` holds the main file's size after a main-file write but the SUM of the attachments after an
attachment write (and other writers set it their own way), so the size read before an append is wrong whenever attachments exist and a correct append is reported as
"could not be verified" (a retry then duplicates the text); a file listed in the record but missing in storage, two attachments with the same name, a
failure after the text was stored, and a racing writer give the same false answers (and an equal-length racing writer a false success); the route's append
decodes the stored bytes as UTF-8, which corrupts a Latin-1 or UTF-16 `.txt` uploaded through the portal; and rewrites of the shared file list by other
files' writes can orphan a file. A safe append needs the actual text read before and after (prefix and suffix check), one lock per knowledge base, and a
refusal for text that is not valid UTF-8; that is a separate change.

Proof: `backend/src/mcp/server/__tests__/knowledgeBaseWriteTools.test.ts` (the earlier tests unchanged and green, plus the list query tests).
