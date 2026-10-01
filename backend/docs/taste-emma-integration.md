# Emma × Taste — integration and UX contract

Status: downstream experiment in `kvnloo/agentweb`.

Taste is not a new agent persona and it is not a replacement for Brand Guidelines.
It is a preference layer that helps Emma choose between multiple valid creative directions.

## 1. Two layers, one UX

### Taste Profile — what this user tends to like

The Taste Profile is learned only from sources the user explicitly imports or refreshes.

Current sources:
- X bookmarks through an already-connected AgentWeb X account
- caller-supplied reference collections / design notes

Future adapters can include uploaded screenshots/design dumps, Figma boards, Pinterest-like collections, LinkedIn saved items, approved creative history, and explicit "more like this / less like this" feedback.

Raw source content is intentionally not part of the durable profile. The durable representation is bounded aggregate preference signals.

### Taste Skill — how Emma turns preference into higher-quality creative work

The Taste Skill is the creative quality policy derived from the `design-taste-frontend` approach:
- infer the brief before styling
- understand audience, page/content kind, reference signals, and existing brand assets
- use deliberate `DESIGN_VARIANCE`, `MOTION_INTENSITY`, and `VISUAL_DENSITY` dials
- choose a real design system when the brief implies one instead of inventing a fake one
- avoid generic AI-default composition and "AI slop"
- preserve existing design language in redesigns unless the user asks for an overhaul
- treat accessibility/performance as constraints, not aesthetics
- run a final pre-flight check

The profile supplies the user's prior. The skill supplies the decision process.

## 2. Precedence

Taste never outranks truth or an explicit request.

1. platform, legal, safety, accessibility, and compliance constraints
2. explicit user instruction for the current task
3. Brand Guidelines, founder voice examples, ICP/audience, and the existing design system
4. measured performance and task evidence
5. Taste Profile
6. generic model defaults

This order is important. A user's bookmark history must never:
- change an analytics value
- change CRM/lifecycle state
- suppress disconfirming research
- override an ad policy requirement
- silently restyle an established brand
- replace a source image or persisted logo
- alter an offer, campaign objective, or factual claim

## 3. UX model

### The user-facing mental model

**Teach Emma → see what Emma learned → choose where it applies → override locally when needed.**

Users should never need to understand Account Memory, embeddings, system prompts, tool routing, or model context.

### Taste Center

Customer workspace route: `/marketing/taste`.

The page has four jobs:

1. **Creative fingerprint**
   - reference count / source count
   - aggregate signal chips
   - derived design/motion/density dials
   - no raw private source display

2. **Teach Emma**
   - explicit "Learn from bookmarks" action for a connected X account
   - reference collection input
   - future source adapters appear here, not scattered through settings

3. **Where Emma uses Taste**
   - persistent `Off | Subtle | Strong` per surface
   - creative surfaces default stronger
   - operational truth surfaces default off

4. **Privacy & control**
   - explain that source data is not retained in the profile
   - "Clear learned Taste" deletes learned aggregate signals
   - clearing Taste does not disconnect accounts or delete source data
   - surface defaults remain unless separately reset

### Chat UX

Taste should be ambient but visible when it materially influences output.

Good:
- `Taste: Strong · minimal + editorial · motion 4/10`
- "more like me" → task-local Strong
- "neutral for this one" → task-local Off
- "always use strong Taste for social" → persistent setting change

Bad:
- asking the user to install a Taste skill every chat
- auto-importing bookmarks because X is connected
- changing persistent settings because of a one-off instruction
- repeatedly asking for Taste confirmation
- showing or reconstructing private bookmarks

### Artifact UX

Artifacts should carry lightweight provenance:
- Taste profile/application schema version
- surface
- intensity
- aggregate signals/dials used
- generated timestamp

Do not store raw source items in artifact metadata.

This makes later questions answerable:
- "Why did Emma make it look like this?"
- "Was Taste active on this campaign?"
- "Did this scheduled run use the old or new profile?"

## 4. Surface policy

| Emma surface | Default | How Taste should help | What must outrank Taste |
| --- | --- | --- | --- |
| Landing pages | Strong | layout, typography, composition, motion, density, design-system choice | brief, brand, audience, accessibility, existing site |
| Images | Strong | art direction, composition, materiality, visual rhythm | source images, logo, facts, requested content |
| Video | Strong | pacing, framing, transitions, type, visual world | source frames, story continuity, brand, accessibility |
| Brand exploration | Subtle | directions, metaphor, material/world exploration | saved brand identity and explicit brand strategy |
| Social content | Subtle | angle, rhythm, specificity, formatting choices | founder voice, platform norms, factual claims |
| Ad creative | Subtle | creative prior for variants | performance, offer, objective, policy/compliance |
| Blog/editorial | Subtle | structure, pacing, examples, visual/editorial character | facts, citations, explicit voice |
| Research | Subtle | examples/reference ranking and presentation | evidence, source quality, uncertainty, contrary findings |
| Reply curation | Subtle | rank which complete/fresh candidates feel relevant | freshness, completeness, current goal |
| Email | Off | opt-in presentation/voice preference only | explicit voice, recipient/context, deliverability |
| CRM/lifecycle | Off | none by default | CRM truth |
| Analytics | Off | presentation only if explicitly requested | measurements and attribution |

## 5. Emma feature map

### Brand Guidelines and Market Strategy

Taste can propose creative directions but must never silently write them into Brand Guidelines or Market Strategy.

Recommended flow:
1. read Brand Guidelines / Market Strategy
2. preview `brand` Taste application
3. propose a direction and explain the difference
4. update durable brand state only after the existing confirmation contract

Brand is organizational truth; Taste is personal preference.

### Landing pages, HTML, and coding agents

Taste is most valuable here.

Current generation path applies `landing_page` Taste automatically at the backend boundary, so REST/MCP/Agent Mode converge.

For edits:
- preserve existing system by default
- "make it more like me" can raise task-local intensity
- an explicit redesign/overhaul instruction can permit stronger structural change
- publication remains a separate action

Future coding-agent context should attach the same Taste Application receipt rather than re-deriving preferences independently.

### Images

Current `generate_image` flow applies Taste automatically.

Taste changes:
- composition
- material language
- typography direction
- visual density
- art direction

Taste does not change:
- exact source images
- persisted brand logo
- factual values
- requested subject/content
- the image-edit confirmation gate

`taste_intensity` supports task-local Off/Subtle/Strong.

### Video

Current `generate_video` flow applies Taste automatically.

Taste affects motion language, pacing, framing, typography, and art direction.
Reference frames and explicit story requirements remain authoritative.

### Social / LinkedIn / X

Taste should be a light prior, not a substitute for founder voice.

Order:
1. Brand Guidelines / founder Voice Examples
2. platform constraints
3. the actual topic/source material
4. Taste as a tie-breaker

Examples:
- choose between a terse vs editorial structure
- rank visual directions
- choose which reference examples feel aligned
- influence line-break/rhythm choices only when voice examples do not settle them

Publishing remains separately confirmed/gated under existing rules.

### Reply Guy

Taste can re-rank valid candidates.
It must not create candidates to satisfy the profile.

Candidate quality contract remains:
- fresh
- complete post text
- working link
- useful suggested reply

Taste only changes ordering or drafting style.

### Paid ads

Taste belongs on the creative side only.

Keep two memories separate:
- **preference memory**: what the user likes
- **performance learning**: what actually performs

Performance evidence, offer clarity, objective, spend constraints, and platform policy outrank Taste.

This makes useful experiments possible:
- Brand-only
- Brand + Taste
- Brand + performance learnings
- Brand + Taste + performance learnings

Do not collapse them into one opaque "personalization" score.

### Deep research and web/news search

Taste may:
- prioritize examples to show first
- surface references likely to be useful
- choose presentation density / structure

Taste may not:
- change findings
- drop contrary evidence
- lower source-quality standards
- change confidence/uncertainty
- alter citations

The result should remain defensible if Taste is turned Off.

### Knowledge Base / Drive / ClickUp / files

Knowledge sources can provide explicit reference material.
A future "Use as Taste source" action should be opt-in and create an aggregate snapshot; merely attaching a file to the KB should not silently train Taste.

### Blog, books, and editorial artifacts

Taste can influence:
- structure
- section rhythm
- visual direction
- examples and references
- editorial character

Factual content, citations, and brand voice remain independent.

### CRM, leads, lifecycle, sequences

Taste is Off.

These tools represent operational truth and actions. Preference should never change:
- lifecycle computation
- lead status
- scoring
- enrichment
- enrollment logic
- deletion/filter logic

Taste can still style a *presentation* of CRM data if the user explicitly requests a designed report, but not the underlying decision.

### Email

Taste is Off by default.

Email has stronger context-specific constraints: recipient, thread, founder/company voice, deliverability, and intent.
A user can opt in per task or persist a preference, but Emma should not assume that visual/social taste is email voice.

### Analytics and data analysis

Taste is Off for the analysis itself.
It may be opted into the report presentation layer only.

Numbers, attribution, diagnosis, and recommendations based on measured evidence must be invariant to Taste.

### Work plans

A work plan should resolve Taste independently for each creative step.

Example:
- research step → Subtle
- landing-page step → Strong
- ad creative step → Subtle
- CRM enrollment step → Off

The plan should not carry one global "Taste on" boolean.

### Scheduled chats and unattended runs

Schedules need reproducibility.

At execution:
- resolve the user's persisted surface default
- record the Taste Application receipt/version with the artifact
- never refresh/import new Taste sources unless the schedule explicitly says to

Future option: pin Taste profile revision for campaigns where visual stability matters.

### Skills

Taste read/preview/settings are foundation capabilities, not an installable dependency.

Other skills can consume Taste through a stable contract:
- `get_taste_profile`
- `get_taste_settings`
- `preview_taste_application`

That avoids duplicating preference logic across every skill.

### MCP / REST / ChatGPT plugins

Taste should be transport-independent.

REST:
- `GET /api/taste/profile`
- `GET /api/taste/settings`
- `PUT /api/taste/settings`
- `GET /api/taste/application`
- `POST /api/taste/apply`
- explicit source imports
- profile deletion

Emma tools:
- `get_taste_profile`
- `get_taste_settings`
- `update_taste_settings`
- `preview_taste_application`
- `refresh_taste_from_x`

A ChatGPT plugin/MCP product can use the same contract without receiving social credentials or AgentWeb internals.

### Voice / Fathom / Slack

Taste should not alter factual meeting/email/workspace retrieval.

Potential uses are presentation-level:
- how summaries are structured
- which creative examples to show
- whether a creative brainstorm is terse vs exploratory

Do not infer durable Taste from ordinary conversations without an explicit "learn this preference" action.

### Human evaluation and revisions

Human eval should score two dimensions separately:
1. objective artifact quality / correctness
2. Taste alignment

A beautiful artifact that violates the brief is not "high Taste."
A high-performing ad the user personally dislikes is useful evidence, not a profile failure.

Future feedback controls:
- More like this
- Less like this
- Ignore this for Taste
- Make this a durable reference

These should create explicit preference evidence with provenance.

## 6. Scope model

Near term:
- User Taste Profile
- persistent per-surface user defaults
- task-local intensity override

Future hierarchy:
1. user/global Taste
2. org/brand constraints
3. campaign/project Taste overlay
4. task-local override

There must be no cross-user or cross-org learning by default.

## 7. Microservice boundary

Taste should remain extractable from AgentWeb.

Core inputs:
- normalized source items
- tenant/user id
- surface
- optional task-local intensity

Core outputs:
- aggregate Taste Profile
- Taste Application
- dials/signals/guardrails
- prompt context
- receipt metadata

Adapters:
- AgentWeb X OAuth/bookmarks
- AgentWeb Account Memory
- future file/Figma/source connectors

This boundary is what makes Taste sellable independently without giving the microservice ownership of social credentials.

## 8. Current downstream implementation

Implemented:
- secure X bookmark import
- generic bounded collection import
- aggregate-only durable profile
- delete
- persistent per-surface defaults
- task-local intensity overrides
- first-class Emma read/preview/settings/explicit-refresh tools
- Agent Mode policy for when Taste should/shouldn't apply
- automatic backend application for landing pages, images, and video
- versioned Taste application receipts with semantic profile/settings revisions, threaded into landing/image/video results
- durable write-once Taste receipts on generated landing-page artifact records, across v0 and coding-agent paths
- REST surface/application/apply/settings APIs
- customer Taste Center at `/marketing/taste`

Not yet implemented:
- screenshot/Figma/design-dump visual ingestion
- "more like this / less like this" artifact feedback
- campaign/project overlays
- durable receipt storage for non-landing artifacts and scheduled-run replay/pinning
- landing-page edit/coding-agent automatic receipt injection
- social/research candidate re-rankers
- eval dashboard comparing Brand-only vs Brand+Taste
- standalone service extraction/billing

Those are follow-up slices, not reasons to weaken the current privacy boundary.
