## ENG-2819: Classify email-draft no-contact/DNC refusals as by_design (2026-11-05)

`classifyToolFailureType` now treats update_email_draft_for_lead's deliberate
no-contact-channel skip (ENG-2082) and do-not-contact refusal as `by_design`,
so the agent-mode failure-cluster loop stops filing them as handler bugs.
