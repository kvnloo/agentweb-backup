## ENG-2459: finalize guard — remove the false-alarm causes found in the shadow window (2026-10-13)

The guard ran in shadow mode 2026-09-28..2026-10-12 and wrote 52 `claim_mismatch` run verdicts (42 distinct sessions). The ticket's
review found no completed action without a backing call among them. A read-only recount from the stored sessions, with no model call,
agreed where it could check: for the 26 sessions whose final reply still contains a lexicon candidate, the added tools fully back the
candidate classes in 15, and the claim sentence behind the other 11 is, in 10, a mention of an existing schedule, a withheld or refused
action, or next-step advice (one, a "schedule active" line in a status summary, could not be settled from the sentence). The other 16
sessions no longer have candidate text in their last assistant message, so they were not checked.

- Matchers: `notify_session` backs `email_sent`; `add_gtm_work_items` / `update_gtm_work_item` back `task_created_or_updated`;
  `post_on_connected_account` backs `post_published`; `create_html_file`, `update_html_file`, `create_html_from_template` and
  `create_social_media_posts` back `asset_generated` (the paused-confirmation check still applies to media-gen tools only);
  `create_knowledge_base`, `update_knowledge_base_file` and `attach_knowledge_base_files` back `settings_saved`. Read-only
  knowledge-base tools do not.
- Judge output: a claim counts only when its class was a lexicon candidate for that text and its `statement` is non-empty. The prompt
  now tells the judge to skip negated, withheld, drafted, zero-count, quoted and already-existing statements and next-step advice.
- Not changed: shadow/enforce behaviour. Enforce still needs `AGENT_FINALIZE_GUARD=true`; with both flags unset (prod today) the guard
  does not run. The earlier-invocation ledger for retry-nudge and "continue" runs is a separate follow-up.
- Rollout: flags stay unset. Run a second shadow window and re-measure precision before any enforce use.
