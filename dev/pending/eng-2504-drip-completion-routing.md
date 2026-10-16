## ENG-2504: Pure drip completion -> newsletter-segment routing decision (2026-10-15)

Added `backend/src/services/dripSequenceRouting.ts` `completionRouting()`: delivered no-response completions with a configured segment route to `add_to_segment`; untouched leads, all stop reasons (unsubscribed/bounced compliance, replied/booked sales-owned), missing segment and unknown outcomes return `none`. Pure; not yet wired into the worker.
