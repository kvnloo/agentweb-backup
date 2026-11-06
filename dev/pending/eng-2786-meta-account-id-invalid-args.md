## ENG-2786: list_meta_ads_campaigns missing account_id classified invalid_args (2026-11-03)

Client_id-scoped Meta calls without account_id now throw a usage (invalid_args) error listing the client's candidate account_ids instead of being clustered as config/auth. No auto-select (ENG-1801 invariant kept).
