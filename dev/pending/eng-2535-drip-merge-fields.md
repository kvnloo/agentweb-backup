## ENG-2535: Pure drip-email merge-field renderer (2026-10-18)

Added `backend/src/services/dripSequenceMergeFields.ts`: pure `renderDripTemplate` ({{field}} / {{field|fallback}}, HTML-escape in html, CR/LF stripped from subject, `missingFields` report, `strict` mode fails closed). Not yet wired into dripSequenceWorker.
