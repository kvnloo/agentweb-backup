You are verifying whether a bug fix actually works, by driving a REAL browser.
Do NOT change any code — this is verification only.

## The bug (Linear {{IDENTIFIER}})

Title: {{TITLE}}

{{DESCRIPTION}}

## A full running copy of the FIXED app is available at

- Customer portal: {{CUSTOMER_URL}}
- Partner portal:  {{PARTNER_URL}}
- Backend API:     {{API_URL}}

Test login (use if the bug needs a signed-in view): {{TEST_EMAIL}} / {{TEST_PASSWORD}}

## How to verify

1. Use the Playwright browser tools (`mcp__playwright__browser_navigate`, `_snapshot`, `_click`, `_type`, `_take_screenshot`, etc.) to open the relevant portal.
2. Log in with the test account if the bug requires it.
3. Reproduce the EXACT scenario from the bug report and observe whether the buggy behavior is gone.
4. Take a screenshot of the key state with `mcp__playwright__browser_take_screenshot`.
5. If the bug is purely backend/API (nothing visible in a browser), exercise it against {{API_URL}} with `curl` (via Bash) instead. If you still can't confirm, report `inconclusive`.

Be rigorous and HONEST. A page that merely loads is NOT proof — you must actually exercise the bug's scenario. If you cannot confirm the fix, say `not_fixed` or `inconclusive`; never claim a success you did not observe. Note: API calls may fail if a flow needs data you don't have — judge based on the specific bug.

## Required final output

The VERY LAST line of your response must be exactly:

VERIFY_RESULT: {"verdict":"verified|not_fixed|inconclusive","scenario":"<the exact scenario you reproduced>","summary":"<one or two sentences on what you did and saw>","screenshots":["<screenshot path>"]}
