## ENG-2570: call_hubspot_api CONTACT_LIST GET recovers list id sent in query (2026-10-19)

Gateway repair moves an unambiguous id in `query` ({listId}, "listId=17", 17) to `list_id` for CONTACT_LIST GET only. Child of ENG-1246 degradedRunRate cluster work.
