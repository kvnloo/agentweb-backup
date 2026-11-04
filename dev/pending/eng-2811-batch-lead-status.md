## ENG-2811: Batch lead conversation-status read tool (2026-11-04)

New read-only `get_lead_conversation_statuses` tool returns compact status rows (connection, last message channel/direction/date, reply state) for a whole list (cursor paged) or up to 200 lead_ids in one call, so audits no longer fan out one call per lead. Constant query set; ids outside the list return not_found.
