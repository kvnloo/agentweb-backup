## ENG-2630/2631/2632: InMail api flag, Attio company lists, Attio duplicate list entries (2026-10-22)

- `sendInMail` now passes `api: 'classic'`; unipile-node-sdk 1.9.3 drops `linkedin[inmail]` otherwise.
- `AttioService.getAllLists` normalises array/UUID `parent_object`; company lists route to `companies`.
- Agent ADD_ENTRIES dedupes ids and upserts via `PUT /lists/{id}/entries`; REMOVE_ENTRIES deletes every matching entry (paged `findListEntries`).
- Existing duplicate entries are NOT cleaned up (production data delete; needs Harsha approval).
