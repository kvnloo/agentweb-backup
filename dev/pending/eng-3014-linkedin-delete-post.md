## ENG-3014: LinkedIn delete-post action on linkedin_manage_post (2026-11-15)

- `linkedin_manage_post` gains `action=delete_post` (`account_id`, `post_urn`; share and ugcPost URNs; company page and personal). Token is used server-side in `LinkedInAdapter.deletePost` and never returned or logged.
- Authorship is settled before any write: a stored row naming another author refuses with no LinkedIn call; with no stored row the post's live `author` must equal the account URN. Unreadable authorship fails closed.
- Success is reported only after a GET readback returns 404. A still-readable post or a failed readback is reported as not confirmed, and the stored row is kept.
- On verified delete the row is removed from AW-ConnectedAccountPosts by its existing key (`linkedInPostsDb.deletePost`). No table, index or key change.
- Unattended runs: `delete_post` is on the gated side of both `DISPATCHER_PUBLISHING_ACTIONS` and `ACTION_SCOPED_PUBLISH_TOOLS`, so an approval-required schedule holds it and an ungranted schedule cannot call it. This differs from `delete_tweet`, which is ungated.
- Rollback: revert the commit. Nothing is persisted that needs cleanup.
