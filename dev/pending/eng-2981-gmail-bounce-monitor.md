## ENG-2981: Gmail bounce monitor auto-DNCs leads (2026-11-12)

New `cron/gmailBounceMonitorCron.ts` (every 15 min) polls connected Gmail mailboxes for mailer-daemon/postmaster DSNs, flags permanent 5.x recipients do-not-contact across all owner lists, and records `email.bounced` events (eventId `gmail-bounce:<msg>:<rcpt>`). Watermark `GmailConfig.lastBounceCheckAt`; first run seeds to now.
