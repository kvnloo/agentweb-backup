## ENG-2407: batch-review create restricted to caller-entitled Slack channels (2026-10-12)

POST /api/batch-review/create now 403s unless the channel is in the caller user/org configured Slack channels (getEffectiveAllowedChannels) or the caller is a real admin; check runs before any DB write or Slack post.
