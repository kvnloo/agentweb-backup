## ENG-2488: Partner-portal custom subscription link form (2026-10-14)

Admin-only "Create custom subscription link" button + validated form on the Users org cell, calling the existing `POST /api/admin/custom-subscription-links` (ENG-2428). Hidden unless `VITE_CUSTOM_SUBSCRIPTION_LINKS=true` (default off). No schema/webhook changes.
