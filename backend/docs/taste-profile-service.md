# Taste Profile service (downstream experiment)

Taste turns a user's explicitly imported reference collections into small preference profiles Emma can use as context. This slice is intentionally **profiling/RAG context, not model fine-tuning**.

## API

All routes require normal AgentWeb authentication.

### `POST /api/taste/import/x`

```json
{ "accountId": "<existing AgentWeb X connected-account id>" }
```

The backend reuses the existing X OAuth connection and `twitterService.getBookmarks()`. Access tokens, refresh tokens, cookies, passwords, and other credentials are not accepted by this endpoint.

### `POST /api/taste/import/collection`

```json
{
  "collectionId": "optional-stable-id",
  "items": [
    {
      "url": "https://example.com/reference",
      "title": "reference title",
      "text": "optional notes or exported description",
      "creator": "optional creator",
      "tags": ["minimal", "motion"]
    }
  ]
}
```

This endpoint is deliberately data-only. It parses URL metadata but **never fetches caller-provided URLs**. That makes the v1 boundary useful for design dumps, bookmark exports, moodboards, and future source adapters without introducing an SSRF primitive.

### `GET /api/taste/profile`

Returns the aggregate profile for the authenticated user.

### `DELETE /api/taste/profile`

Deletes all durable Taste Profile memories for the authenticated user.

## Privacy model

Raw source items are ephemeral. The durable representation contains only:

- source type and item count
- aggregate domains
- aggregate terms that occur at least twice
- bounded style signals

The connected account ID is hashed before it becomes a source key. Raw bookmark text, URL paths, collection items, and social credentials are not written to Account Memory.

Taste snapshots are saved as `preference` memories using the `taste-profile:v1:` source prefix. That deliberately reuses AgentWeb's existing Account Memory injection path, so Emma can use the profile without a new prompt-injection or agent-loop path.

## Microservice seam

The core service depends on two narrow interfaces:

- `TasteXBookmarkReader`: source read adapter
- `TasteMemoryStore`: durable aggregate store

That keeps AgentWeb-specific OAuth and memory plumbing outside the profiler. A standalone service can later replace either adapter while preserving the source-normalization/profile contract.

Future adapters can cover LinkedIn saved items, uploaded archives, Figma boards, Pinterest-like collections, screenshots, or customer design libraries. Each adapter should preserve the same invariants: explicit user import, least privilege, no surprise crawling, raw-source minimization, tenant isolation, deletion, and bounded outputs.

## Security invariants

1. No social credential is accepted by the Taste API.
2. X account ownership is checked by the existing connected-account path.
3. Missing and cross-tenant X account IDs have the same external error.
4. Generic collection fields are allowlisted and bounded.
5. Credential-shaped fields are rejected.
6. Raw sources are not persisted.
7. No source adapter performs a social write.
8. Re-importing the same source replaces its aggregate snapshot instead of multiplying durable memories.
9. Delete removes only Taste-prefixed memories.
10. Imports are rate-limited per authenticated user.
11. Durable Taste sources are capped at 16 per user; re-importing the same source replaces it.

## Acceptance tests

```bash
cd backend
npm test -- --runInBand src/__tests__/tasteProfileService.test.ts src/__tests__/taste.routes.test.ts
npm run typecheck
npm run build
```

Keep this experiment downstream until security, privacy, and usefulness evals are strong enough to justify an upstream proposal.
