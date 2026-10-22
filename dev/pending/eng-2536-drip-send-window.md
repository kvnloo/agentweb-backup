## ENG-2536: pure drip-send window scheduler (2026-10-19)

- Added `backend/src/services/dripSendWindow.ts` `nextAllowedSendAt()`: earliest instant >= dueAt inside the recipient's local [startHour, endHour) window on allowed weekdays; falls back to `fallbackTimezone` (`usedFallback: true`); DST gap/overlap handled; invalid config returns typed errors. Not wired into dripWorker yet (ENG-2167).
