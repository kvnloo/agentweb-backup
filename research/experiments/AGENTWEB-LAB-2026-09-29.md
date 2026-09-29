# AgentWeb downstream architecture lab — 2026-09-29

Base: AgentWebPro/agentweb@6c621125eb49bbbb45f733d3c309c04c04bf1f7a

## Operating rule

Each experiment must:
1. test one architectural hypothesis;
2. remain pure, shadow-only, or dependency-injected;
3. define a measurable failure condition;
4. avoid production writes and permissions;
5. be independently promotable or disposable.

## Experiment matrix

| ID | Hypothesis | Primary metric | Promote if |
|---|---|---|---|
| A1 lifecycle-model | Derived lifecycle eliminates stale-state drift better than stored snapshots | wrong-stage decisions across mutation sequences | zero stale classifications on fixture transitions; no destructive-filter regression |
| A2 prefetch-generation | Generation IDs + bounded admission prevent stale async prefetch from overwriting newer intent | stale-result commits, admitted bytes | zero stale commits; bounded memory/work |
| A3 reliability-receipt | A small normalized receipt contract can unify tool/reliability evidence without replacing existing ledgers | terminal outcomes lacking evidence | every terminal outcome maps deterministically; unknown stays unknown |
| A4 capability-manifest | Capability metadata can choose MCP/direct/browser/manual handoffs without prompt-only policy | unnecessary human handoffs + forbidden-route selections | fewer handoffs with zero forbidden selections |
| A5 voice-serializer | Per-session sequencing prevents draft/publish races in duplex voice | cross-session or out-of-order commits | zero misbound commits under adversarial interleavings |
| A6 lesson-promotion | Evidence + review gates can promote reusable lessons without self-reinforcing bad state | unsupported promotions | zero promotions below evidence/review threshold |
| A7 route-shadow | A tiny deterministic/JEV-shaped router can offload obvious choices while abstaining on ambiguity | agreement on high-confidence fixtures + abstention | high-confidence agreement >= 95%; ambiguous cases abstain |

## Promotion ladder

fixture -> adversarial fixture -> shadow receipt -> downstream dogfood -> narrow upstream RFC/PR

Do not promote an experiment because it is interesting. Promote only when its measured result resolves a real upstream tradeoff.
