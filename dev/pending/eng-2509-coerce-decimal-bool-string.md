## ENG-2509: Coerce finite decimals/booleans to string for exactly-string tool schemas (2026-10-16)

`validateAndRepairToolArgs` now repairs finite non-integer decimals and booleans passed where the property schema is exactly `string` (`String(value)`, `scalar_coerce` repair). Bare integers remain limited to id-named fields, so `file_url: 123` / `action: 7` still fail as `type_mismatch`. NaN/Infinity/unsafe ints, containers, null, multi-type schemas, and values outside a declared enum are never coerced.
