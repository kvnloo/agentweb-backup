## ENG-2870: LinkedIn identity guard accepts the same full name split differently (2026-11-08)

- `unipileNameMatches` (used by the pre-send `linkedInIdentityCheck`) now accepts when both sides carry first+last and the normalized concatenated full names are identical. Prod session 28f84741 (LinkedIn Outreach – Retail Masivo AR) was refused twice for "Diego Javier Llorente" vs "Diego Javier Llorente" (CRM "Diego"/"Javier Llorente", LinkedIn "Diego Javier"/"Llorente"); the agent burned steps working around it before hitting the step cap. Step cap and resumable-report behaviour unchanged.
