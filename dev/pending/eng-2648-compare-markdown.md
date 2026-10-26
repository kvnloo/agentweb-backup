## ENG-2648: Compare asks every model for Markdown (2026-10-23)

`COMPARE_SYSTEM_PROMPT` now tells each compared model to answer in Markdown, without HTML tags, and to put requested HTML/code in a fenced code block. Before, output format differed by vendor (Claude Sonnet 5 answered in HTML tags, the others in Markdown) in side-by-side cards that all render through the portal's sanitized `MarkdownMessage` (rehype-raw + rehype-sanitize default schema), so HTML answers rendered differently from the rest. Display/safety unchanged: the portal already sanitized both forms.
