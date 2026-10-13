## ENG-2442: Meta connection alerts dedupe onto per-account canonical (2026-10-13)

raiseMetaConnectionHandoff now uses the tracking monitor token alert identity (Alert Class meta-token-invalid + Alert Scope meta-ad-account:<id>), so re-fires comment on the open per-account canonical instead of filing a new issue each tick.
