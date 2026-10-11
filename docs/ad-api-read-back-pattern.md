# Ad API read-back pattern (ENG-592)

A mutate response that says "success" is not evidence the change landed. Google Ads has
accepted campaign updates (bidding strategy, final_url_suffix) while leaving the field
unchanged (ENG-286, ENG-312), and Emma reported them done.

Rule: every mutation on an external ad API either

1. reads the resource back and throws a typed read-back error when a requested field did not
   land (Google: `GoogleAdsReadBackError`, `code: 'unsupported_field'`, `fields: [...]`), or
2. is listed in an explicit exemption map with a reason.

Updates: compare each requested field against the read-back row (Google returns int64 as
strings; compare as strings). Missing resource on read-back is a failure.

Removes: pass when the resource reads back `REMOVED` or is not found; anything else throws.

Creates: the returned resource name is the evidence; exempt with reason.

Tool boundary: the tool handler maps the read-back error to `success: false` with
`errorType: 'unsupported_field'` and the field list. Never convert it to success.

Coverage guard: `backend/src/__tests__/eng2398.mutationReadBack.test.ts` enumerates every
public mutation-shaped method on `GoogleAdsService` and fails when a new one is neither
verified nor exempt. LinkedIn/Meta slices should add the same enumeration test for their
service classes. Tests use stubbed `mutate`/`search` fixtures only; no live network in CI.
