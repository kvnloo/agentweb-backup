## ENG-2572: wrap IIFE/bare-expression playwright_browser_evaluate function args (2026-10-19)

The gateway now wraps a non-function `function` arg as `() => (<expr>)`. Before this, these calls failed in prod with "result is not a function" (7 rows, 10-14..10-18).
