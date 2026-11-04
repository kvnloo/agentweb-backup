## ENG-2271: hot-lead call stuck-record sweep (2026-11-04)

A daily sweep (`services/voice/stuckCallSweep.ts`, `cron/stuckCallSweepCron.ts`, 12:00 UTC in `server.ts`) now finds
hot-lead call records that stayed live longer than a call can last and settles them from Twilio's own record of the
call. It ships REPORT-ONLY: set `HOT_LEAD_CALL_STUCK_SWEEP=close` to let it write, `off` to disable it.

- No table, index or migration. Candidates: orgs with any hot-lead config (`orgDb.listHotLeadCallOrgIds`, so an org that
  released its number is still swept) -> members
  -> lead lists -> the newest 500 leads per list through `crmDb.findLeadsBySystemRecord` (a partition query with a
  state/updatedAt filter, so the read cost is leads examined: capped at 10,000 per run, 50 records settled per run).
  Lists of departed members and records beyond the newest 500 leads of a list are not
  covered.
- Thresholds are derived from the call flow (`STUCK_AFTER_MS`): ring 25 s, prompt 8 s, `<Dial timeLimit>` 1800 s, plus 10
  minutes of grace; `between_attempts` 70 minutes (a further attempt is refused after `maxAgeMinutes`, at most 60).
- Twilio decides liveness: new read-only `VoiceProvider.fetchCall`. A live leg is never touched. Ended legs are metered
  through the webhook's own `meterLeg` (exactly-once) and the record is finished with the normal rule. The sweep never
  asks for a next member and never places a call (the lead is called at most once), and it runs with
  `hot_lead_call_mode` off.
- Left for a human, logged every run: a record with no member/lead call sid (`dialing`, `placement_unknown`, `bridging`
  without a lead sid) and an ended `completed` call whose duration Twilio did not give (never defaulted to 0).
- A Twilio or store failure changes nothing for that record and turns the summary line into an error.
- Not verified against real Twilio: that the Call resource's `duration` matches the callback's `CallDuration`.
- Go-live item 16: read the report-only output before switching to `close`. Runbook: "Stuck records" in
  `backend/docs/integrations/hot-lead-call.md`.
