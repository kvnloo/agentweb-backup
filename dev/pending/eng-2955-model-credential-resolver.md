## ENG-2955: Pure model-credential resolver for BYOK vs platform keys (2026-11-12)

Added `backend/src/services/modelCredentialResolver.ts`: pure, unwired resolver choosing a customer BYOK API-key ref (billed customer_direct) or the platform default (agentweb_metered); rejects subscription/OAuth logins and unknown providers with typed errors; cross-tenant guarded; returns ref ids only. Slice of ENG-2851.
