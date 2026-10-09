## ENG-2371: automatic media-batch continuation, no customer "reply continue" (2026-10-09)

Adds `services/agentMode/mediaBatchContinuation.ts` (in-memory store, runner over the ENG-2370 state machine, structured unit/completion logs) and stops the media-budget deferral prompt from asking customers to reply "continue". No schema changes; durable store is slice C.
