## ENG-1853: Approval Desk card amounts and approver mapping (2026-10-22)

- Meta Graph returns budgets as numeric STRINGS in minor units ("3000"). CAMPAIGN `daily_budget`/`lifetime_budget`/`spend_cap` proposals are forwarded as cents; `budget_amount` and every AD_SET `daily_budget`/`lifetime_budget`/`bid_amount` are DOLLARS (the write path multiplies by 100). `buildMetaWriteConfirmation` formats each side by its own unit — keep it in step with `updateMetaAdsCampaign`/`updateMetaAdsAdSet` if either changes.
- Budgets the write path drops (AD_SET create under a CBO campaign; `budget_amount` without `advantage_campaign_budget`; `budget_amount` beating `daily_budget`) are shown as "Not applied", not as changes.
- The Desk only knows who is logged in via `approval_inbox_reviewer_{matt,fangfang,harsha}_email` (AW-Settings, env fallback `APPROVAL_INBOX_*_EMAIL`). Unset => that person gets a 403 and no queue. All Meta writes route to Matt (`getDefaultApproverForGate`).
- A tracking-check override on a card shows the WARNING line, but the dispatch strips `override_tracking_check`, so the launch gate still blocks. Safe direction, misleading wording.
