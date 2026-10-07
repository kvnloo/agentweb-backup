## ENG-976: post_on_account replies on X via in_reply_to_post_id (2026-10-07)

`post_on_connected_account` / MCP `post_on_account` accept optional `in_reply_to_post_id` (X only). It routes through TwitterAdapter.createPost -> postTweet({inReplyToTweetId}) behind the same ENG-827 publish re-check. Omitted means the original-post path is unchanged; other platforms are refused with nothing posted.
