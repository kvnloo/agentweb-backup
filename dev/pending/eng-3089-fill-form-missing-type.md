## ENG-3089: fill_form kept failing on a missing field type after the name repair (2026-11-16)

- After #3927 (ENG-2858) repaired a missing `fields[].name`, `playwright_browser_fill_form` kept failing. Read from the loop events: four failures after the merge, three with `fields[0].type` invalid (name present, no type) and one with `selector` in place of `ref`. None was a stale ref or page state.
- The gateway repair now sets `type: "textbox"` on a field that has a text value and no type. It does not overwrite a type the model sent and does not guess for a value of `true` / `false`, which is a checkbox or radio.
- A field with no `ref`, or with a missing or unknown type that was not repaired, is rejected before the call with a next-step message (take a snapshot, retry with the ref; or the list of valid types) instead of the Playwright MCP zod dump. `@playwright/mcp` 0.0.70 declares `ref` as a required string, so these calls could not succeed before either.
- If a defaulted textbox is really a select or checkbox, Playwright's `fill` throws on it. That is a visible error, not a wrong write.
