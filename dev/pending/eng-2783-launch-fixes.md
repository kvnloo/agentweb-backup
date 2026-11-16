## ENG-2783: hot lead calls launch fixes (2026-11-16)

Found by walking the customer path before launch; each checked against the code and prod data first.

- The portal read-out told a customer on the right plan "Your plan may not include hot-lead calls" once the paid add-on was required and not yet bought. `entitled` is now the plan check, and a blocker explains the add-on and that Emma sells it (the portal cannot buy it). An org that is already on and has lost the add-on sees the same blocker in Emma's read-out.
- Emma no longer sells the add-on while the global `hot_lead_call_mode` switch is off, and checks again right before charging: setup does not need the switch, so without this a customer could pay $70 for calls that cannot happen. An org that already has the add-on is not blocked.
- The add now confirms the created item with a read before mirroring it, and refuses when the read fails (the retry finds the paid item, no second charge). Duplicate-item cleanup moved to a helper that works on the items just read.
- Launch order, because of who is on which plan (27 of 33 Pro accounts have no Stripe subscription): billing required first, then tick `hot_lead_call` on the plans, then the kill switch. Ticking a plan while billing is off lets every owner on it call at AgentWeb's Twilio cost.
