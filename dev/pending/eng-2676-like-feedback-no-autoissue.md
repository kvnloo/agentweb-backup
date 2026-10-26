## ENG-2676: Stop filing Linear Bug issues for like feedback votes (2026-10-26)

Agent-mode and iShare message feedback now call `fileAutoIssue` only for `dislike` votes. Likes are still persisted and injected as system context; they are sentiment, not defects. Tests: `backend/src/__tests__/agentMode.feedbackLinear.test.ts`.
