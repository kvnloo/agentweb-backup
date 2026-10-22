## ENG-2542: Pure drip-sequence health auto-pause decision (2026-10-19)

Added `backend/src/services/dripSequenceHealth.ts`: `decideSequenceHealth` pauses a sequence when bounce rate > 5% or complaint rate > 0.3% after >= 50 sends (overridable). Pure, not wired.
