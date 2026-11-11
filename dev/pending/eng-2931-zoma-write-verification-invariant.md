## ENG-2931: Zoma writes never report success on failed/unverified writes (2026-11-11)

- Meta guarded writes and AD_CREATIVE CREATE: a dispatch throw (timeout/transport) now returns
  `UNCONFIRMED` (may have applied, do not retry blindly) instead of an unhandled error.
- AD_CREATIVE CREATE accepted with no creative id is `UNCONFIRMED`, not "not created".
- UPLOAD_VIDEO still processing returns `success: false` (was `success: true` with `UNCONFIRMED`).
- Table-driven invariant test covers Meta campaign/ad set/ad/update, creatives, and Google
  budget/campaign writes x {provider error, 5xx, timeout, missing id, read-back failure,
  read-back mismatch}; creates still land PAUSED. No persistence change.
