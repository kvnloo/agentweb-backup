# A5 — Duplex voice serializer

Hypothesis: per-session sequence tokens and a publish fence eliminate stale draft capture and overlapping publish races.

Falsify on any cross-session or out-of-order commit.

Metrics: stale commits, overlapping publish admissions, session isolation.
