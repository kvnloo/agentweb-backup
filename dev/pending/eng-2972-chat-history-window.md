## ENG-2972: get_chat_history accepts an omitted time window (2026-11-12)

- `get_chat_history` start_time/end_time are now optional; a missing window defaults to the trailing 24h ending now. Fixes schema_reject (invalid_args) when the model calls it without a range. Invalid/inverted windows return an actionable error.
