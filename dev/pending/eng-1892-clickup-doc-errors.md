## ENG-1892: Classify write_clickup_doc failures (2026-10-28)

write_clickup_doc now returns errorType (configuration / invalid_parameter / not_found / runtime) with the HTTP status, a short ClickUp body, and next-step guidance; malformed arguments are rejected locally naming the parameter.
