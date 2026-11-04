## ENG-2809: CONVERSION_ACTION UPDATE accepts bare ids and aliases (2026-11-04)

- `call_google_ads_api` CONVERSION_ACTION UPDATE normalises a bare numeric id, `conversion_action_id`, or `resource_name` to `customers/<cid>/conversionActions/<id>`; missing identifier now returns a model-facing error naming CONVERSION_ACTION LIST instead of throwing; cross-customer resource names are refused.
