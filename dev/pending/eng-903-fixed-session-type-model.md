## ENG-903: An explicit model on a fixed-model session type is refused, not ignored (2026-10-09)

`POST /api/agent-mode/sessions` and `POST /api/agent-mode/skill/:skillId/session` used to silently ignore a
request `llmModel` for skill, emma-sidebar and every non-`regular` session type (report, image, video,
book, scheduled, ...): those sessions run on an admin-configured model. They now answer HTTP 422
`{ error: 'This kind of session uses a fixed model and does not accept a model choice.', code: 'model_not_selectable_for_session_type' }`
before the skill lookup, the idempotency claim and any write. Absent or blank `llmModel` is unchanged, as are
ordinary chat sessions (still `model_unavailable` 422 for an unserved/unselectable model).

Evidence no known caller sends it: the customer portal creation payloads (ChatSupport/Emma sidebar, Reports,
Images, Videos, Books, CRM, voice lab) carry no `llmModel`; the MCP `emma_create_session` sends only
`llmModel` with no `sessionType` (an ordinary chat session). Not changed here: `runVerifiedChat` still
overwrites the stored model with the task-type model when `requiredFunctions` include
update_html_file/read_file_content/create_blog_article/generate_image/generate_video and no `params.llmModel`
is passed (interactive /verified-generate passes none).
