## ENG-2993: perform_data_analysis dead file URLs classify as invalid_args, not config (2026-11-13)

- An HTTP 4xx (except 429) when downloading a caller-supplied `file_urls` entry now returns `errorClass: 'invalid_args'` with guidance to re-run the producing tool or inline the data.
- Previously it fell to `not_found`, which `classifyToolFailureType` maps to `config`, so the failure-cluster loop filed "resolve the account" issues for model-supplied dead links.
- Network errors and 429s keep their existing classes.
