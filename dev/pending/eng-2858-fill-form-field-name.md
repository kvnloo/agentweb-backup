## ENG-2858: Repair fill_form fields missing name (2026-11-07)

agentToolGatewayService fills a missing `fields[i].name` for playwright_browser_fill_form from element/label/description/field, else ref, fixing the Playwright MCP zod invalid_type at fields[0].name.
