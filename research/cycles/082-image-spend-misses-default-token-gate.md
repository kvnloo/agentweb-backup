# Cycle 82 — Image spend does not move the default token gate

**UTC:** 2026-09-11T21:48:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not touch:** billing / `ENFORCE_COST_CAP` / ENG-1250 admission.

## Question

Cycle 80: quota is the MCP brake. Cycle 81: that quota is
check-then-act. Does `checkTokenUsage` even *see* image spend —
or does the leaf write dollars into an observe-only dimension
while the live gate is still token-count?

## Finding

**The leaf meters `$` with `inputTokens: 0` / `outputTokens: 0`.
The default hard gate is tokens. Image spend increments
`tokenUsage.totalCost` and does not move `totalTokens`. Unless
`ENFORCE_COST_CAP` or a versioned `llmUsagePolicy` is enforcing
cost, `requireEmmaTokenBudget` can keep returning `allowed` after
N Hermes `generate_image` CallTools.**

Cycle 80’s “quota is the brake” is true only on the **cost**
dimension. The code’s default gate is the **other** dimension.

### What the leaf writes

`imageGeneration.ts` L551–563:

```
void meterUserUsage({
  ...
  inputTokens: 0,
  outputTokens: 0,
  costUsdOverride: imageGenerationCostUsd(modelToUse),
});
```

Comment: “Images bill per generation (not per token).”
`meterUserUsage` (`usageRecorderService.ts` L501–516) honors
`costUsdOverride` so the dollar lands on the cap **counter**.
Tokens stay zero.

### What the gate reads

`checkTokenUsage` (`tokenUsageService.ts` L342–396):

- Cost enforcement is **off by default** (observe-only).
- `enforceCostCap = versionedCostPolicyEnforced || ENFORCE_COST_CAP === "true"`.
- If neither, `allowed` is `tokenAllowed` (`tokenPercentUsed < 100`).
- Image ADDs do not change `tokenPercentUsed`.

A user under their token allowance can generate MCP images until
a **different** face burns tokens, or until someone flips cost
enforcement (Harsha / ENG-1116). Do not treat that flip as Q-014.

### Grain is per-face, still a GET

No `checkTokenUsage` in `agentModeService.ts`, `chatbotService.ts`,
`imageGeneration.ts`, or `emma/`. Faces:

| Face | When the GET runs | Then |
|---|---|---|
| MCP | every `POST /generate-image` (`emmaTokenBudget.ts` L171–196) | one image |
| Chatbot | once per HTTP turn (`chatbot.ts` L156) | `generateChatResponse` may `executeTool` N images |
| Agent Mode | once per generate (`agentModeController.ts` L5647 / L9033 / L1334) | whole turn; auto-continuation claims the session **after** the GET (L1350) |

MCP is the *finer* grain (per CallTool). It is still a GET on the
token dimension. In-app is coarser (N images after one GET).

### Reservation rail is tests-only

`spendChargingService.ts` is imported only by
`__tests__/spendChargingService.test.ts`. Step 5 admission is
absent (`spendChargingService.ts` L17–20). The live dual-write
(`spendLedgerDualWrite.ts` L12–13) is observe-only: “NOTHING
READS THESE ROWS.” A fifth `listen()` would not inherit a
reservation that does not exist. Do not wire it onto Q-014.

Hermes/OMP: the agent loop is the spend bound. AgentWeb’s MCP
server lists the tool (Q-014) and meters `$` in the leaf; the
monthly **token** gate is a different instrument. Cutting-edge
is keep the hop; do not HTTP-split to get a second GET; do not
flip cost enforcement from a research timer.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready** (listing still
hits `metered` middleware; the dimensional miss is billing
policy, not a missing nanoservice). A-017 stays park. Do not
set `ENFORCE_COST_CAP` in this tree.

## Next

Cycle 83: cheapest remaining mapping. Candidate: `mcpServerCore`
CallTool has no per-user mutex (L88–120) — Express admits N
concurrent GETs on the same token snapshot. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
