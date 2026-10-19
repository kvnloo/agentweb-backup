## ENG-2535: Pure drip-email merge-field renderer (2026-10-18)

Added `backend/src/services/dripSequenceMergeFields.ts`: pure `renderDripTemplate` substituting `{{field}}` / `{{field|fallback}}` in subject/html/text. HTML-escapes values in html only, strips CR/LF from subject (header injection), reports `missingFields`, and `strict` mode returns `missing_merge_fields` instead of rendering. Not yet wired into dripSequenceWorker.
