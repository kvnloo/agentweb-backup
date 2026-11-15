## ENG-3029: frontier monitor uploads the first Artificial Analysis response page as an artifact (2026-11-15)

- Step 1 of 2. The `Frontier monitor and model catalog` workflow sets `AA_FIRST_PAGE_CAPTURE_PATH`; `fetchArtificialAnalysisModels` then writes the parsed body of page 1 to that path, and the workflow uploads it as artifact `artificial-analysis-first-page` (14 days).
- The file is the response body only: no request, no headers, no key. A body that contains the key is not written. A capture failure goes to stderr and never fails the read. Without the env var nothing is written, so no other caller changes.
- Not done yet: replacing the jest fixture (`artificialAnalysisLanguageModelsFree.json` is still the documented example). That needs the artifact from a real run after this merges; ENG-3029 stays open for it.
