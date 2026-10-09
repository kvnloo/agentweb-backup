## ENG-1271: Staff-operated badge in partner-portal admin users list (2026-10-08)

Partner-portal admin Users table shows a "Staff-operated?" chip under Last seen when `selfActivity.staffOperatedSuspect` is true. The flag comes from GET /api/admin/users (#3038). Frontend only, with no persistence change.
