## ENG-2350: attach_knowledge_base_files crashed on `file_name`/`fileName`; the model never saw the hint (2026-10-19)

- Cause: the tool schema declares `name` per file, but only top-level `required` is enforced, so `{file_name, content}` reached `f.name.replace()` (prod log: `knowledgeBase.js:574`, session 366b42a1, 2026-10-07 18:19-18:22).
- Gotcha: on a `success:false` result, `toolResultError` prefers `error` over `message`. A helpful `message` is invisible to the model; put the actionable text in `error`. The reported session burned its 3-strike retry guard on a bare "Invalid input: empty file content".
- Handled: `name`/`fileName`/`file_name`/`filename` aliases, `files` sent as a JSON string, non-array `files`, non-string `content`, null/string entries. A batch with any bad file is rejected before anything uploads.
- Pre-existing, left alone: attaching to a text-created KB overwrites `knowledgeBaseSize` with the attached files' total (excludes `knowledge-base.txt`), same as `update_knowledge_base_file`. Listing still shows `knowledge-base.txt`.
