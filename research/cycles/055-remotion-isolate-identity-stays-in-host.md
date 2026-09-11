# Cycle 55 — remotion-lambda is the isolate; identity stays in the host adapter

**UTC:** 2026-09-11T20:34:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

AgentWeb already has a fourth deploy unit (`remotion-lambda`). Is that the
nanoservice pattern to copy onto `generate_image`, or is it the Microsoft
“extract when isolation forces it” case that **images do not meet**?

## Finding

**Copy the host-adapter shape, not the Lambda process.** Remotion already
composes the way Hermes / OMP / 2026 modular-monolith say: Chromium/ffmpeg
leave the Node process; `userId` and the meter stay in-process.

### 1. Isolate vs adapter

`remotionService.compose` (`remotionService.ts` L334–291 comment):

1. Load Lambda config (host)
2. `renderMediaOnLambda` L467 (`composition: "BrandedVideo"`)
3. Lambda writes S3
4. Return URL

Meter is **not** in the lambda package: `recordVendorUsage` L2 / L435 / L455
/ L529 / L559 / L582 with `params.userId` and `provider: "remotion"`. The
isolate has no Emma user table.

### 2. The god object still owns the call, not a port

`agentModeService.composeVideo` L29387: `await import('./remotionService')`.
`LoopPorts` (`ports.ts` L143–150) is `s3 | dynamo | bedrock | slack | clock |
logger` — **no remotion, no image**. Creative composition is not the loops
bus. Cutting-edge SDLC here is a later port injection (park: A-005 pile),
not a fifth HTTP Emma process.

### 3. `imageGeneration.ts` is already this adapter

The leaf calls OpenAI / Gemini / Runway over **their** HTTP, then
`meterUserUsage` (`imageGeneration.ts` L551) with `params.userId`. There is
no Chromium/conda reason to fork a process. A-006 would insert
**AgentWeb HTTP** in front of a leaf that already speaks vendor HTTP —
unlike Remotion, where the isolate is our ffmpeg runtime.

Hermes tools call vendor APIs in-process. OMP `pi-ai` 0.85.1 registers
images in-process (`images.js`, cycle 54). Agent-engine (cycle 27) is the
other justified isolate (Playwright + conda). Images match neither.

## Queue effect

None. A-006 stays discard (new citation: copy remotion’s **adapter**, not
its Lambda). Q-016 (MCP video) stays park. Q-001 / Q-014 / Q-003 stay ready.
Do not start a remotion-port extract in the 40k file.

## Next

Cycle 56: cheapest remaining mapping or collision. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
