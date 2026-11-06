## ENG-2808: lead-scoped breaker for add_lead_engagement and sibling lead tools (2026-11-06)

- The tool-failure breaker now scopes add_lead_engagement, get_lead_engagements, update_lead and send_email_to_lead per (list_id, lead_id), like get_lead_details (ENG-969). Three misses on different wrong leads no longer block a corrected call later in the run; repeated misses on the same lead still trip.
- add_lead_engagement's not-found result carries a `hint` telling the model to resolve the lead via search_leads instead of retrying the same pair.
