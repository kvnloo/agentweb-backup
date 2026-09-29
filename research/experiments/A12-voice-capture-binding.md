# A12 — Voice capture attribution

Hypothesis: voice learning should bind approval to an immutable draft snapshot, not merely the current editor text.

Minimal envelope: sessionId + actionId + draft + draft fingerprint + approved text.

Falsify if the existing approval flow already carries a stronger immutable identity, or if the extra identity cannot survive the UI/backend boundary.

Promotion target: H-VOICE frontend wiring. The backend can keep consuming the draft string after the boundary validates the binding.
