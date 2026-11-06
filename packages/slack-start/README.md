# @agentweb/slack-start (ENG-2782 S2)

Embeddable "Get started in Slack" onboarding wizard. **One codebase** — a Preact
core (`src/Wizard.tsx`) — shipped three ways:

| Artifact | Use |
|---|---|
| `dist/slack-start.js` (IIFE, served by the backend at `/embed/slack-start.js`) | any site, no build step |
| `dist/index.mjs` | `mountSlackStart(el, opts)`, `autoBind(opts)`, `openSlackStart(opts)` |
| `dist/react.mjs` | `<SlackStartButton apiBase=…>` React adapter (React is a peer dep; the wizard is still the Preact core) |

All copy, steps and options come from `GET /api/onboarding/slack-start/config`
(backend `services/slackStart/slackStartConfig.ts`). The widget contains no
business logic: step 1 POSTs immediately (research starts), every later step
PATCHes before continuing, completion calls `/complete` and shows an honest
pending state while Slack invites are off.

## Mount

Script tag (binds every `[data-agentweb-slack-start]` element, including ones added later):

```html
<script src="https://api.agentweb.pro/embed/slack-start.js" defer></script>
<button data-agentweb-slack-start>Get started in Slack</button>
```

The API base defaults to the script's origin. Override with `data-api-base` on the
`<script>` or on a single trigger (e.g. `https://api-stage.agentweb.pro`).
`window.AgentWebSlackStart` exposes `open`, `mount`, `autoBind`, `closeAll`.

React:

```tsx
import { SlackStartButton } from '@agentweb/slack-start/react';
<SlackStartButton apiBase="https://api.agentweb.pro" className="btn">Get started in Slack</SlackStartButton>
```

The site's origin must be on the backend allowlist: `*.hireemma.ai` and `*.agentweb.pro`
are built in; add others with `SLACK_START_ALLOWED_ORIGINS` (exact origins, comma-separated).
Requests are non-credentialed.

## Theming

Scoped CSS under `.aw-ss-root`; override variables anywhere above it, e.g.

```css
:root { --aw-ss-accent:#0a66c2; --aw-ss-button:#0a66c2; --aw-ss-radius:6px; --aw-ss-font:Inter,sans-serif; }
```

Variables: `--aw-ss-accent --aw-ss-text --aw-ss-muted --aw-ss-border --aw-ss-bg --aw-ss-track
--aw-ss-button --aw-ss-button-text --aw-ss-error --aw-ss-radius --aw-ss-font`.

## Behavior

- `role="dialog"`, `aria-modal`, labelled by the step heading; focus moves in, Tab is trapped,
  Escape / × / backdrop close and focus returns to the trigger.
- The step is mirrored in `?aw_slack_step=N` (browser back/forward + analytics). The intake
  token is a bearer capability kept in `sessionStorage` only — never in the URL.
- Reload resumes the intake at its furthest saved step; an invalid saved intake starts fresh.
- Load/save/complete failures show the error with **Try again**; a retried start reuses the
  same `Idempotency-Key`, so it cannot create a second intake.
- Captcha: Cloudflare Turnstile is rendered on step 1 only when the config publishes a site key.
- Analytics: `window` receives `agentweb:slack-start` CustomEvents (`open`, `step_view`, `started`, `completed`).

## Develop

```bash
npm ci
npm run typecheck
npm test               # Vitest + React Testing Library (jsdom)
npm run build          # dist/* and backend/src/embed/slackStartBundle.generated.ts
npm run check:size     # fails above 40 KB gzip per artifact
npm run check:embed    # fails if the backend's served copy is stale
npm run test:e2e       # Playwright (Chromium, desktop + mobile), API mocked via page.route
```

**After any change, run `npm run build` and commit the regenerated
`backend/src/embed/slackStartBundle.generated.ts`.** CI (`Slack-start widget build`)
fails if it is stale or any artifact exceeds the budget. The bundle lives in a TS string
constant because the backend's EB bundle ships only `dist` + `package.json` (same reason as
`backend/src/sdk/awSdkSource.ts`).
