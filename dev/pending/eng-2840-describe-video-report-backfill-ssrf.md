## ENG-2840: describe_video and the HTML-report text backfill fetch only through the SSRF-guarded fetch (2026-11-27)

- Found while researching the next batch of MCP tools (W2-10). Both are live in Emma today; neither is on the MCP server.
- `describe_video` (`emma/impl/video.ts`): a non-YouTube URL was downloaded with a plain axios GET, with no host check, default redirects
  and no timeout.
  - Any signed-in user could make the server request an internal address, through Emma's tool or `POST /api/emma/describe-media`
    with `type: "video"`.
  - It now goes through `fetchCallerUrlBuffer` (`utils/callerUrlFetch.ts`):
    - DNS is pinned to a public address, and every redirect is checked again.
    - The size is capped while downloading (`MAX_DOWNLOADED_VIDEO_SIZE_MB`, default 100 MB).
    - The whole download is bounded at 180 s.
  - A refused URL gets the one generic refusal. YouTube URLs are unchanged, because Gemini fetches them itself.
  - The video is now held in memory (up to the cap), written to the temp file, and then released before the Gemini upload. Before, it was streamed to disk.
  - A download that hits the time limit says so plainly.
  - A `MAX_DOWNLOADED_VIDEO_SIZE_MB` that is not a positive number falls back to 100 MB. Before, NaN turned the cap off.
- HTML-report backfill (`routes/tasks.ts`, `enrichHtmlReportsWithSearchableText`):
  - A session's report URLs are scraped from chat text (`utils/scanMessagesForAssets.ts`). The pattern accepts any host when
    `.amazonaws.com/` appears later in the URL.
  - The reports read, and `search_user_assets`, then fetched each one with plain axios.
  - Now only a URL of our own bucket (`isS3Url`) is read, through `fetchCallerUrlText`, with a 5 MB cap and 15 s total.
  - Any other URL is skipped, so it gets no searchable text, the same as when a fetch failed before.
  - The tag stripping was quadratic on hostile HTML: 50 KB of "<" blocked the event loop for 1.3 s, and a user can put such a
    file in their own reports.
    - `utils/htmlSearchableText.ts` now does it in linear time, with the same text as before on normal reports.
- Impact checked: the production hosts require IMDSv2, so a plain GET could not read instance credentials. Other internal addresses were reachable.
- Not changed:
  - The scrape pattern itself: report listing is unchanged.
  - The knowledge-base update route's fetch of `result_files` URLs (`routes/tasks.ts`, about line 1617): those URLs are written by
    the server, not chosen by a caller.
- Proof:
  - `agentModeService.describeVideo.test.ts`: guarded download, refusal, size, timeout, the size-setting fallback, and an empty file.
  - `tasks.searchableTextPersistence.test.ts`: internal, foreign-host and other-bucket URLs are never fetched.
  - `htmlSearchableText.test.ts`: the same text as the old expressions, and linear time on hostile input.
  - A sweep of 22 suites (tasks routes, describe-media, caller-URL and SSRF guard tests): 315 pass.
