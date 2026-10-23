## ENG-2644: Archive/task-status session routes require owner or admin (2026-10-23)

`DELETE /api/agent-mode/session/:id` and `PUT .../task/:taskId/execution/:executionId/status` now 404 unless the caller owns the session or is an admin; `chatbotDb.archiveSession` is conditional on the row existing so an unknown id no longer upserts a ghost row.
