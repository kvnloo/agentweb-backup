## ENG-2550: Pure customer sending-domain readiness check (2026-10-19)

Added `backend/src/services/dripSendingDomainReadiness.ts`: pure decision whether a customer Resend domain (status, SPF, DKIM, from-address match, optional DMARC warning) is ready to send. Not yet wired into the send path.
