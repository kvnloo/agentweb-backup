## ENG-2520: Store-agnostic scheduled-post dispatcher (2026-10-16)

Adds `dispatchDuePosts({ repo, publisher, now })` behind injected repository/publisher ports (in-memory fakes only). Re-checks status before publish; failures are reported and left unchanged until ENG-2519 lands.
