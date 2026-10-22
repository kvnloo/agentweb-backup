## ENG-2620: retry judge replies the provider ended in an error (2026-10-22)

**Why.** A rerun of the ENG-2591 judge trial errored on 13 of 51 test cases with "no JSON object with a verdict". A shape-only diagnostic found the real cause. A provider (Amazon Bedrock, through OpenRouter) can fail partway through a reply and still answer HTTP 200, with `finish_reason: "error"` and null content. When rerun, 12 of the 13 parsed normally.

**What.**
- `readChatCompletion` now returns the completion's `finishReason`.
- The task-success judge and labeller retry a reply that ended in `finish_reason: "error"` or came back empty, up to 2 times. If every attempt fails, the reason names the provider error.
- A call that throws (such as an HTTP 400) is not retried, as before.
