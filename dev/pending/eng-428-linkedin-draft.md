## ENG-428: LinkedIn save-as-draft via post_on_connected_account (2026-10-06)

`post_on_connected_account` gains `save_as_draft` (LinkedIn only; other platforms refused, nothing posted). Draft posts use `lifecycleState: DRAFT`, skip the published-posts cache, and return no feed URL.
