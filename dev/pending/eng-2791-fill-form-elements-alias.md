## ENG-2791: Accept `elements` alias for playwright_browser_fill_form `fields` (2026-11-03)

Added `fields: [elements]` to DEFAULT_ARG_ALIASES in agentToolGatewayService so model calls using the upstream `elements` name are repaired instead of schema-rejected. Regression test in agentToolGatewayService.test.ts.
