## ENG-113: Compare models keeps the unchosen answers (multiverse view) behind compare_save_alternatives (2026-10-12)

Before: "Continue with this answer" appends ONE user+assistant pair and the other columns are lost, so a user could
never revisit the possible outcomes or branch from a different one.

Now, with AW-Settings `compare_save_alternatives` = exactly `true` (absent / any other value / cold-start read failure
= off = old behaviour; 60s cache, last-known value on a failed refresh, `services/agentMode/compareSaveAlternatives.ts`):

- `POST /compare` also returns `alternativesToken`, an HMAC (same key derivation as the select token, with a `kind`
  tag so the two are not interchangeable) over `{userId, sessionId, compareId, prompt, issuedAt}` and the sorted SET of
  `{model, sha256(content)}` of EVERY ok column. The switch is not part of it; it is issued whenever >= 2 columns are ok.
- `POST /compare/select` accepts optional `alternatives:[{model,content,latencyMs?}]` + `alternativesToken`. When the
  switch is on and the token verifies (constant time) over the alternatives PLUS the chosen answer (so the set is exactly
  the ok columns the server produced: nothing added, edited, dropped or re-attributed; models distinct; max 3; each
  content <= 200k chars), the assistant row the select already appends gets `metadata.compareId` and
  `metadata.compareAlternatives:[{model,name,provider,content,latencyMs}]`. name/provider come from the server registry
  (`getModelCompareInfo`), never the client; latencyMs is clamped display data. Any failure => alternatives ignored,
  logged (reason only), select still succeeds for the chosen answer. Replay returns the existing pair and never rewrites;
  409 `compare_already_selected` unchanged; select makes no model call, so usage/cost are unchanged.
- Size (fail closed): the serialized alternatives array must be <= 120,000 UTF-8 bytes AND the whole assistant row must
  be <= 341,808 bytes (`MAX_MESSAGE_CONTENT_SIZE` 350,000 minus 8,192 headroom, `COMPARE_ROW_CAP_BYTES`). The headroom exists
  because a later like/dislike/edit re-runs `shrinkMessageForPersistence`, which truncates the chosen ANSWER before it
  drops metadata; a row accepted right at 350,000 lost answer characters after a feedback write. A row accepted this way
  is returned untouched by the guard, now and after a feedback write (both tested). Otherwise NONE are stored (never a partial set)
  and the row gets `metadata.compareAlternativesOmitted:'size'`; if even the marker would not fit under the cap the
  message is stored exactly as today (the chosen answer is never put at risk for a marker). Bytes are measured as
  JSON-escaped UTF-8 (CJK/emoji/control chars), not characters.
- Exposure: `filterMessagesForClient({omitBranchOrigin:true})` (share/ishare `getSharedConversation`, `getConversableSession`)
  now also drops `compareAlternatives` by the same mechanism as `branchOrigin`. The MCP admin transcript and the
  summarizer/judge/replay inputs build `{role, content}` from an explicit field list, so they cannot carry it; a tripwire
  test fails if any file outside a 5-file allowlist mentions the key.
- LLM context: `isReplayableTurn`/`buildCompareMessages` and `buildMarketingContext` read only role/content/flags; tests
  prove the built context is identical with and without alternatives (hostile alternative text included).
- Branching: copied rows lose `compareAlternatives`/`compareId`/`compareAlternativesOmitted`. New optional request field
  `alternativeModel` ("Branch with this answer"): the target must be an assistant message whose
  `compareAlternatives` contains that model (400 `no_saved_alternatives` / `alternative_not_found` otherwise); the
  branch copies rows 0..N-1 (generic strip) and row N with `content` and `llm` replaced by the alternative's,
  `metadata.branchedFromAlternative:{model}`, alternatives removed; the new session's model is the alternative's
  (resolved as an explicit choice through the usual entitlement/usage policy). `llmModel` must equal
  `alternativeModel` when both are sent. The idempotency scope appends `alternativeModel` only when present, so existing
  scopes are byte-identical.
- Capability hint: `compareSaveAlternatives` (boolean) on `GET /api/agent-mode/model-options`, next to `chatBranchingEnabled`.

Storage: owner-approved additive free-form `metadata` keys; no schema/index/table change. Rollback: set the switch to
anything but `true`; already-saved alternatives stay on their rows (owner-only, stripped from non-owner views).
