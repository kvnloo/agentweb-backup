## ENG-2459: a saved LinkedIn draft no longer backs a "published" claim (2026-10-13)

`post_on_connected_account` strictly backs `post_published`, but with `save_as_draft` it also succeeds, so a reply claiming the post was
published passed the guard (the "known limit" in the ENG-2459 precision change). The ledger result for this tool is minimized to `{}`,
so a result check cannot see it; the ledger entry now also carries the call's arguments (`FinalizeLedgerEntry.args`), and both the
strict and the loose matcher skip a call with `save_as_draft: true` (or a result flagged `draft`) for `post_published`. The same applies to
`publish_blog_article`, which saves a CMS draft unless `status` is exactly `published` (the `publish_` prefix strictly backs `post_published`). A loop-level
test pins the hand-off, because unit tests that build ledger entries by hand cannot catch a missing one.

Not changed: `create_social_media_posts` still strictly backs a "published" claim although it only builds an HTML file of drafted posts
(pre-existing, listed in the precision change's known limits). Shadow/enforce behaviour and the flags are untouched; the guard is off in
prod while both flags are unset.
