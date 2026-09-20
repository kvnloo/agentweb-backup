# AgentWeb Open GTM / Arena / OpenAvatar working notes

Private working notes. Keep public issues narrow and implementation-shaped.

## Product thesis

AgentWeb can become an open execution/evaluation substrate for GTM agents while Emma remains the opinionated context-rich orchestration product.

Three public surfaces can share one underlying contract:

- **Arena**: collect blinded human preference data for ads, landing pages, launch assets, UI/UX, and later full GTM trajectories.
- **GTM-Bench**: reproducible agent benchmark over artifact quality, outcomes, cost, reliability, and safety.
- **Market**: eventually allocate real work/prize pools to agents with empirical capability histories.

Shared unit:

```
Task -> Agent config -> Artifact/action -> Evidence -> Evaluation -> Reward
```

Do not launch this as one monolithic RFC. Ship small primitives that Emma dogfoods.

## Lineage

Earlier AgentWeb discussions evolved from evolutionary ad agents into economic actors: agents compete, estimate capability/cost, bid for work, and gain/lose reputation or stake from outcomes. That became the FactoryBench / FactoryMarket idea: hosted evals, capability certificates, bounties/prize pools, verification, and later a market. The later AODL work generalized some of the same ideas around intent, resolution, execution, and verified outcomes.

The current `gtm-arena` is a useful first implementation, but should not be treated as the boundary of the idea.

## Industry shift worth exploiting

### 1. Bookmarks and moodboards -> structured personal libraries

Pinterest boards made saving/curating visual ideas a mainstream behavior. Pinterest explicitly describes saves as a way people refine taste and says recommendations improve as people save more.

Are.na moved the model toward long-lived research collections: blocks + channels, private/public collections, reuse across contexts, API access.

Raindrop makes personal bookmark collections searchable, portable, and integrated with sources such as X and YouTube.

Cosmos is now explicitly positioning saved visual inspiration as a person's "visual DNA": elements, collections, private/public visibility, browser capture, and a personalized feed.

SaaSFrame/Mobbin-style products verticalized this behavior into product-design and landing-page pattern libraries.

### 2. Retrieval -> generative conditioning

Creative AI is moving from "prompt it" toward "show it what I mean."

Adobe Firefly supports style-reference images and custom models trained on a user's own images. The direction is clear: collections of references are becoming reusable generation context.

### 3. Generic AI output -> taste-aware agents

The missing primitive is portability. Today a designer's taste is fragmented across:
- X bookmarks
- Pinterest boards
- Are.na/Cosmos/Raindrop collections
- screenshots
- Figma files
- saved ads / launch videos
- landing-page inspiration
- hand-built swipe files

OpenAvatar could own a portable **Taste Library / Taste Card** alongside identity, likeness, spoken voice, and written voice.

Important: the portable object should default to references + annotations + provenance, not copied copyrighted assets.

### 4. GTM tooling -> AI-native operators, but integration burden remains

The 2026 State of GTM Engineering survey reports:
- 84% Clay usage among GTM engineers
- ~70% adoption of AI-native coding tools such as Cursor/Claude Code
- poor integrations / closed ecosystems as a leading tool complaint
- clunky interfaces and cost/flexibility as additional complaints
- bandwidth as the #1 bottleneck for 25% of respondents

Interpretation: users do not mainly need another copy generator. They need agent-native capabilities that are composable, reliable, inspectable, and cheaper to maintain.

## OpenAvatar: portable taste

Long-term shape:

```
Open Identity Card
  identity
  likeness
  spoken voice
  written voice
  taste
    collections
    references
    annotations
    provenance
    visibility
```

Potential sources later:
- X bookmarks/folders
- Pinterest boards
- Are.na channels
- Cosmos collections
- Raindrop collections
- local screenshots/files
- Figma links
- user-curated ad / landing / launch-video libraries

Do not begin with importers, embeddings, recommendation engines, or model training.

Start with a local/open schema and a simple add/list/export workflow.

## Arena: taste flywheel

Arena should stay extremely low-friction for voters:

```
Which one wins?
[A] [B]
```

No scoring rubric on the default surface.

Instead, vary the binary question:
- Which would you click?
- Which makes the product clearer?
- Which feels more trustworthy?
- Which would you remember?
- Which page makes you more likely to try the product?

This permits a multidimensional preference model without making the UX feel like labeling work.

Longer-term signals:

```
human taste
+ target-persona taste
+ brand taste
+ individual taste
+ real campaign outcome
```

A particularly valuable dataset is disagreement between preference and behavior:
"people preferred A, but B converted better."

## Emma -> small JEV-like GTM primitives

Avoid publishing random MCP wrappers. Extract small benchmarkable kernels from the capabilities Emma already relies on.

Candidate kernels:
- `meta-doctor`: campaign/account diagnosis from observed state
- `meta-plan`: typed proposed mutations
- `meta-guard`: approval/policy classification
- `meta-verify`: intended vs observed state
- `creative-rank`: pairwise preference / artifact ranking
- `brand-fit`: artifact vs brand/taste context
- `lander-critic`: structured page findings
- `lead-rank`: calibrated ICP relevance
- `attribution-reconcile`: reconcile conflicting channel evidence
- `gtm-router`: match tasks to workers/capabilities

Each should be:
- narrow
- deterministic where possible
- fixture-backed
- replayable
- usable by Emma through the exact same public-ish contract
- independently versionable later

## Meta launch strategy

Harsha explicitly wants a JEV-like tooling launch and called Meta Ads a plausible first extraction.

Do not begin by splitting a repository or cloning Meta's API.

First dogfood an extraction boundary inside AgentWeb:

1. read-only normalized account/campaign snapshot
2. deterministic findings from existing AgentWeb invariants
3. one job-shaped Emma/MCP surface
4. fixture/replay coverage
5. no new persistence, spend, publish, or external write

If that proves useful internally, extract it into a standalone OSS package/service with the same contract.

Next likely slice: read-after-write `meta-verify` receipts.

## Execution doctrine

Ideas are cheap. Optimize for Harsha's review minutes.

For each slice:
1. map to an existing pain or owner ask
2. reuse current AgentWeb contract/code
3. keep blast radius tiny
4. avoid new persistence until necessary
5. define acceptance in observable terms
6. dogfood through Emma
7. extract only after the internal boundary is stable

Do not ask Harsha to review a platform thesis to get one useful tool merged.

## Initial issue ladder

Public/private implementation issues should remain much smaller than this document:

- AgentWeb: **Meta Doctor v0** read-only normalized diagnostic surface
- GTM Arena: **multimodal matchup v0** for image ad creatives while preserving blind one-click voting
- OpenAvatar: **Taste Library v0** local portable reference manifest + add/list/export

Park for later:
- X/Pinterest/Are.na/Cosmos/Raindrop importers
- personal taste embeddings
- Arena taste profile import/export
- GTM-Bench task format
- sponsored challenges/prize pools
- capability passports
- bidding / bonds / market settlement
- outcome-calibrated taste models

## Research references

- Pinterest visual discovery / boards:
  - https://business.pinterest.com/en-us/how-pinterest-works/
  - https://create.pinterest.com/en-us/product-features/how-to-create-boards/
- Are.na:
  - https://www.are.na/about
- Cosmos:
  - https://help.cosmos.so/en/articles/11846092-intro-to-cosmos
  - https://www.cosmos.so/
- Raindrop:
  - https://raindrop.io/
- X bookmarks API:
  - https://docs.x.com/x-api/posts/bookmarks/introduction
- SaaSFrame:
  - https://www.saasframe.io/
- Adobe style references/custom models:
  - https://helpx.adobe.com/firefly/web/work-with-images/generate-images/reference-images-for-styling.html
  - https://blog.adobe.com/en/publish/2026/03/19/adobe-firefly-expands-video-image-creation-with-new-ai-capabilities-custom-models
- GTM Engineering:
  - https://knowledge.gtmstrategist.com/p/the-2026-state-of-gtm-engineering


## Created first slices (2026-09-20)

- Meta Doctor v0: https://github.com/kvnloo/agentweb/issues/32
- GTM Arena multimodal image-ad matchup: https://github.com/AgentWebPro/gtm-arena/issues/1
- OpenAvatar Taste Library v0: https://github.com/kvnloo/openavatar/issues/2


## Arena repository identity check (2026-09-20)

Current evidence says `AgentWebPro/gtm-arena` is **not a GitHub fork** of a surviving `kvnloo/*arena*` repository:

- GitHub reports `fork: false`, `network_count: 0`.
- The repository was created 2026-03-11.
- Visible history begins with Harsha creating a fresh Next.js app, followed by Harsha-authored Arena commits.
- No currently accessible `kvnloo/*arena*` repository was found by installed-repo or public-repo search.
- `kvnloo/gtm-test` was checked and is unrelated; it is the private X/voice corpus project.

Therefore treat the older Kevin Arena / FactoryBench / FactoryMarket thesis as a separate conceptual lineage unless an older renamed/deleted repository is recovered later. Do not assume AgentWebPro/gtm-arena is the canonical original.

## OpenAvatar execution slices created

- #2 Taste Library v0: https://github.com/kvnloo/openavatar/issues/2
- #3 Taste manifest schema: https://github.com/kvnloo/openavatar/issues/3
- #4 privacy-safe Taste Card: https://github.com/kvnloo/openavatar/issues/4
- #5 X bookmarks adapter: https://github.com/kvnloo/openavatar/issues/5
- #6 agent-facing taste context pack: https://github.com/kvnloo/openavatar/issues/6
- PR #7 portable manifest: https://github.com/kvnloo/openavatar/pull/7
- PR #8 local CLI (stacked on #7): https://github.com/kvnloo/openavatar/pull/8
