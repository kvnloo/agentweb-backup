## ENG-2531: Pure cautious org/contact matcher for Fathom recordings (2026-10-18)

Added `backend/src/services/fathomOrgMatcher.ts`: read-only port-injected matcher, precedence email > domain > CRM > review; ignores @agentweb.pro, free-mail domains, and title/name-only evidence; conflicts return review with candidates. Not wired into any route yet (ENG-246 parent).
