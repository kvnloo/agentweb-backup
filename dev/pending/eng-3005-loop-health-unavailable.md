## ENG-3005: Distinguish unreadable loop history from empty history (2026-11-14)

Loop health reports now return a typed `unavailable` entry with unknown (`null`) counts when a learning-store read fails. A fixed error code replaces raw exception details. Successfully read loops retain their existing lifecycle states and counts, even alongside a failing loop. No persistence or authorization changes.
