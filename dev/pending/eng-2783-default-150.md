## ENG-2783: hot-lead call monthly default lowered to 150 (2026-11-13)

The default `maxCallsPerMonth` for a hot-lead-call org is now 150 (was 200). It is the allowance in the plan price (100 included calls plus headroom).
Orgs with a stored value keep it; an org with no stored value now reads 150. Owners may still set 1 to 200 themselves (the owner ceiling is its own constant,
no longer derived from the default); 201 to 2000 stays an operator write. No data migration. To revert, set the default back to 200 in `hotLeadCallConfig.ts`.
