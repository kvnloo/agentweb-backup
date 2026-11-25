## ENG-2964: permanent sent-message records, production shadow

- Created production AW-SentMessages via standalone CloudFormation, us-west-2, PITR/SSE/Retain.
- Success-only detached recording at sendAsSender and LinkedIn message/InMail; default shadow,
  SENT_MESSAGE_LEDGER_MODE=off rolls recording back without deleting history. Never blocks sends.
- Original conditional-claim enforcement service remains dark. Direct provider bypasses and
  LinkedIn org attribution remain gaps before enforcement. Review readiness after ~3 clean days.
- Scoped Jest 31/31 pass; docs/eng-2964-sent-message-ledger.md describes remaining work.
