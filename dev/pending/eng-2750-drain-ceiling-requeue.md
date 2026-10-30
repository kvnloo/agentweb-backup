## ENG-2750: Drain-ceiling shutdown requeues scheduled chats silently once (2026-10-29)

- `isWorkerShutdownError` now recognises `Worker shutdown — drain ceiling exceeded`.
- A scheduled chat killed by a drain before any assistant output is requeued once (existing ENG-971 ledger-guarded requeue) without filing a zero-output Linear issue; a failing retry files a single issue.
