## ENG-2840: knowledge base over MCP can narrow and page its list, and append to a file instead of only replacing it (2026-11-20)

Two knowledge-base tools on the MCP server left out inputs that Emma's own tools take. Both now have them. The REST routes are unchanged, so the customer
portal and Emma behave as before. Creating a knowledge base through MCP still makes a PRIVATE one only (a public file would let an outside agent publish), and
the other knowledge-base tools (`create_knowledge_base_file`, `delete_knowledge_base_file`, `search_knowledge_base`, `read_knowledge_base_files`) are untouched.

- **`list_knowledge_bases`** sent no query at all, although the route behind it (`GET /api/emma/knowledge-bases`) and Emma's `list_knowledge_base_files` take
  `kb_type`, `modified_after`, `modified_before`, `limit` and `offset`. A caller could neither narrow a large account's list nor page through it. The tool now
  takes all five (`backend/src/mcp/server/knowledgeBaseParams.ts`). `kb_type` is one of `google-drive`, `private`, `public`, `clickup`, `clickup-tasks`,
  `foreplay-swipefile`, `foreplay-board` (matched without regard to case); the dates are ISO dates such as `2026-04-15` (a date or a date with a time);
  `limit` and `offset` are whole numbers, given as a number or as digits in text. Empty, blank and 0 mean "not given". Anything else is refused by name
  before any call: the route would turn it into NaN or ignore it, and an ignored filter returns the whole list and looks like a match. With no arguments the
  call is exactly what it was. `limit` and `offset` apply per knowledge base source, as they do for Emma.
- **`update_knowledge_base_file_content`** could only replace a file. It now takes `mode`: `replace` (the default, so no existing caller changes meaning) or
  `append`, which adds the content after the stored text with a blank line between (what Emma's append does) and never loses what is stored. A mode that is
  neither is refused. An append to a file that does not exist is "not found" (the tool never created files; `create_knowledge_base_file` does), and a
  knowledge base that is not the caller's is answered exactly like a missing one. An append is refused when the file would pass 10 MB (the size Emma's own
  update tool allows per call); the per-call content limit stays 1 MB.
- **The answer is read back, as before.** After a replace the tool reports the stored key, size and the sha256 of the content. After an append the stored size
  must equal the old size plus the blank line plus the new text, otherwise the answer is a failure ("could not be verified on read-back"); an append answers
  with the stored key and size, the old size and the bytes appended, and no hash (the whole file is not read back, so a hash of "the file" would be a claim
  the tool did not check).
- **Parallel appends:** an append is read, add, write on the storage side, so one agent's appends to one file are taken in turn within the server process
  (the lock the lead tools use, key `kb:<kb>/<file>`); without it two appends sent together would each start from the same text and one would be lost.

**Limits (stated):** (1) the lock covers one server process; appends from different sessions on different instances, or an append at the same moment as a
portal edit, are not serialized. The size check then fails the answer rather than claim a success, but the text of the losing write is gone from the file.
(2) An append to a main file that is empty (the route stores an empty main file as size 1) fails the size check although it worked; the tool never creates an
empty main file. (3) The tests run the tool against a fake of the routes (Google Cloud Storage, which holds the text, is not exercised), so the append
separator and the size bookkeeping are pinned to what Emma's own update code does today, not observed live.

**Behaviour changes for outside callers:** none for a call that sends the old arguments. New refusals only apply to the new arguments.

Proof: `backend/src/mcp/server/__tests__/knowledgeBaseWriteTools.test.ts`.
