## ENG-3066: unattended scheduled runs get the compact brand block up front (2026-11-16)

`prepareTurnContext` (`backend/src/services/agentModeService.ts`) now adds one system message to a scheduled session's unattended turn: the compact brand block from `brandMessagingContextFromGuidelines`, read through `readBrandGuidelines` (so an org member gets the org's brand). It goes after the conversation and before the unattended publish directive, which stays last (ENG-827). `unattendedBrandContextMessage` in `backend/src/services/brandMessagingContext.ts` builds it and returns an empty string when there are no usable guidelines or the read throws; the run continues either way.

Size: a 264-character lead-in plus at most 1,500 characters of brand block, on every turn of an unattended scheduled run for an account that has brand guidelines, whether or not the run writes outreach. Attended turns, including a scheduled session reopened in chat, are unchanged.

Not covered: unattended runs whose session type is not `scheduled`.
