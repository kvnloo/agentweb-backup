## ENG-2361: update_lead_status can save the drafted message on the lead (2026-10-08)

`update_lead_status` accepts optional `message_draft` (LinkedIn text -> `messageDraft.content`) and `email_subject` + `email_body` (-> `emailDraft {subject, textContent}`, format `text`), written in the same update as the status. Lets scheduled drafting agents (Opiner) populate the cross-list Pending Review queue with the exact text they wrote instead of only a daily HTML report. Empty values are ignored and never clear existing drafts; a half email draft is rejected without writing.
