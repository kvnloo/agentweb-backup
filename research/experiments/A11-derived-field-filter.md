# A11 — Derived-field filter semantics

Hypothesis: lifecycle should behave as a virtual, total CRM field rather than a nullable persisted attribute.

Key implication: `lifecycle is_empty` should match **zero** leads. Even the sparsest row derives to `unknown`; storage absence is not semantic emptiness.

This experiment is the safety prerequisite for ENG-2155 writer cleanup.

Falsify if a valid lead state exists for which lifecycle cannot be computed, or if existing user intent relies on "attribute missing" rather than "lifecycle unknown".

Promotion path:
1. replay search/delete fixtures with derived lifecycle;
2. confirm previews do not widen;
3. move shared filter resolution to a small helper;
4. only then remove lifecycle stamps from writers.
