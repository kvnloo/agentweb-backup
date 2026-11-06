## ENG-2784: Caps on inbound hot-lead callbacks (2026-11-06)

`/inbound` (a caller dialling the org's Twilio number back) now takes a slot from the existing limit store
(`AW-MCPSessions`, new `hlc#cap#ih#`, `hlc#cap#id#`, `hlc#in#p#`, `hlc#in#c#` key prefixes only) once a member would be
rung: org hourly/daily at 2 x `maxCallsPerHour`/`maxCallsPerDay`, per caller 3 an hour and 6 a day (HMAC of org and
`From`, never the number), and a CallSid marker so a Twilio retry is counted once. Capped calls hear the nobody message
(`[hotLeadCall] inbound capped <reason> <orgId>`); a store failure fails closed with the unavailable message
(`[hotLeadCall] inbound limits unavailable`). A missing or withheld `From` skips only the caller counters. See
`backend/docs/integrations/hot-lead-call.md` (Inbound callbacks).

This supersedes the "no cap" sentence about inbound callbacks in `dev.md`: inbound callbacks are now capped (above).
