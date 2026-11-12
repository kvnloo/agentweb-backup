## ENG-2962: an agent on Emma's MCP server can no longer approve Emma's own approval cards (2026-11-12)

Some of Emma's actions reach real people and their gates require a person's approval (`answeredBy === 'user'`, delegation
refused): adding or releasing contacts in Smartlead, hot-lead calls, CRM sequence activation, and paused Meta campaign bundles.
An outside agent with a default API key could open a chat, ask for the action, and answer the card itself with
`emma_answer_question_deck`: the answer reached `/api/agent-mode/generate` as a self-call and was recorded as the user's.
Reproduced on the test environment: the agent approved a Smartlead release card and the release ran (nothing changed only
because the contact had never been pushed). Found by the review of the Smartlead MCP tools.

**Fix**
- `authenticateToken` marks a request made with a self-call token (`_svc`, minted only by `mcpFetch`) as `isSelfCall`.
- `generateResponse` refuses (403 `APPROVAL_NEEDS_PERSON`) a self-call deck answer that would approve one of those cards, before
  anything is submitted, with a message telling the person to approve on the card in AgentWeb (the chat link). Declining,
  commenting and answering any other card (plan choices, Meta write decks) through MCP still work.
- `services/personOnlyApprovals.ts` says which cards are person-only (the three reserved card kinds and the paused-bundle write).

**Testing:** route tests (each card kind refused for a self-call; decline allowed; other cards allowed; a person still approves),
auth test (self-call tokens marked, app logins not), helper tests; breakage checks: removing the route check, the auth flag, a card
kind or the per-item match each fails a test. Related suites pass; `linkedInOutreachAuth.saveAccount` and
`agentModeController.conditionalSkip` fail on main already.

**Not changed:** the share-link route (a visitor is a person), and `manage_crm_sequence`'s external activation actions (ENG-2961),
which take the approver's identity from the caller by design.

**Rollback:** revert; no data, table or environment change.
