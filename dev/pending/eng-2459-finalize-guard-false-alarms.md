## ENG-2459: finalize guard — remove the false-alarm causes found in the shadow window (2026-10-13)

The guard ran in shadow mode 2026-09-28..2026-10-12 and wrote 52 `claim_mismatch` run verdicts (42 sessions); the ticket's review found no
completed action without a backing call among them. A read-only recount (PR #3495 description) found the added tools fully back the
candidate classes in 15 of the 26 sessions whose final reply still has a lexicon candidate, and the flagged sentence behind the other 11
is, in 10, not a completed action. The other 16 sessions no longer have candidate text and were not checked.

- Matchers: `notify_session` backs `email_sent`; `add_gtm_work_items` / `update_gtm_work_item` back `task_created_or_updated`;
  `post_on_connected_account` backs `post_published`; `create_html_file`, `update_html_file`, `create_html_from_template` and
  `create_social_media_posts` back `asset_generated` (the paused-confirmation check still applies to media-gen tools only);
  `create_knowledge_base`, `update_knowledge_base_file` and `attach_knowledge_base_files` back `settings_saved`. Read-only
  knowledge-base tools do not.
- Judge output: a claim counts only when its class was a lexicon candidate for that text and its `statement` is non-empty. The prompt
  now tells the judge to skip negated, withheld, drafted, zero-count, quoted and already-existing statements and next-step advice.
- Drafts: a `post_on_connected_account` call with `save_as_draft` (or a result flagged `draft`) no longer backs a "published" claim, in
  the strict or the loose tier. The ledger result is minimized to `{}` for this tool, so the guard now also receives the call's
  arguments (`FinalizeLedgerEntry.args`); a loop-level test pins that hand-off.
- Follow-up, not in this change: `create_social_media_posts` only builds an HTML file of drafted posts, so it should not back a
  "published" claim (it stays in the `post_published` matcher as before).
- Not changed: shadow/enforce behaviour. Enforce still needs `AGENT_FINALIZE_GUARD=true`; with both flags unset the guard does not
  run. The earlier-invocation ledger for retry-nudge and "continue" runs is a separate follow-up.
- Rollout: flags stay unset. Run a second shadow window and re-measure precision before any enforce use.
