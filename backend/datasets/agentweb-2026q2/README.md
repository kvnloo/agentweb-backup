# AgentWeb 2026 Q2 sandbox dataset

ENG-1910 compiles Ryan's frozen, sanitized packet into `agentweb-2026q2@1`.
The supplied acceptance contract is unchanged. These artifacts are for the private
hiring simulation only; the packet grants no public redistribution or ad-launch
permission. Source image bytes are copied without modification, and withheld
creatives use a generated one-pixel gray PNG rather than recovered private media.

Reproduce from the repository root (no AWS access or server required):

```sh
node backend/node_modules/ts-node/dist/bin.js --transpile-only --project backend/tsconfig.json \
  backend/scripts/compile-sandbox-dataset.ts \
  /home/harsha/ryan-takehome-setup/CANDIDATE_PACKET \
  backend/datasets/agentweb-2026q2/case.yaml /tmp/agentweb-2026q2-recompiled
```

The compiler verifies every file in `manifest.csv` against its SHA-256, byte
count and CSV row count before compiling. It reconciles every period/entity
rollup against the applicable daily rows and both performance manifests against
the account totals. Spend is converted with exact decimal parsing into cents.
No missing ad/day observations are manufactured. Six deterministic breakdown
families split integer metrics and actions exactly; those dimensions and reach
are explicitly approximate, never historical observations. Settings are current
snapshots; names, targeting, pages, pixels, audiences and destinations are synthetic.

Verified September 12, 2026 against the accessible original packet:

| Metric | Packet / compiled total |
| --- | ---: |
| Spend | USD 2,055.32 (205,532 cents) |
| Impressions | 22,005 |
| All clicks | 804 |
| Inline link clicks | 436 |
| Reported leads | 32 |
| Reported complete registrations | 17 |
| Reported purchases | 0 |
| Daily rows | 134 |
| Period rows checked | 28 |

`1/reconciliation.json` records these totals and the original manifest SHA-256.
`1/assets` contains 11 supplied PNGs and one synthetic placeholder. Every asset
entry contains its checksum, dimensions and byte count. `sourcePath` describes
packet provenance; `assetKey` resolves relative to the output directory.
Compilation uses only synthetic numeric IDs and `.invalid` URLs. Runtime asset
projection uses the shared immutable dataset prefix, preserving the frozen seed
hash while allowing account-specific prefixes to be reset or purged.

`case.yaml` accepts datasetId, version, caseId, name, currency, timezone, and an
optional reviewWindowSeconds (0–86400). Unknown fields fail closed. The account's
currency and timezone must agree with the source settings when supplied. The
compiler does not import arbitrary account settings, historical IDs, URLs or tokens.
