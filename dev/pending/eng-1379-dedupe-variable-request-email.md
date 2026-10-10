## ENG-1379: Dedupe scheduled-chat variable-request emails (2026-10-10)

A schedule blocked on missing variables no longer mints a new link and re-emails on every due run. While an unconsumed request sent within 7 days is outstanding, the run is skipped silently, the existing token is kept and its expiry extended; a reminder goes out at most weekly. No new schedule fields. Auto-pause after N blocked runs is deferred (needs new durable state).
