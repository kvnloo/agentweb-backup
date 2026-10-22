## ENG-113: per-user "Compare models" preference (2026-10-22)

`User.showModelCompare` (absent = on) is saved through `PATCH /api/users/me/profile` the same way as `emmaTipsEnabled`. Non-booleans get a 400 and nothing is written. `/me` returns the field unchanged because `sanitizeUserForResponse` doesn't strip it. The setting only controls whether the portal shows the Compare button. `/compare` never reads it, and the entitlement, the tier `model_compare` allowlist and the `model_compare_enabled` kill switch work exactly as before.
