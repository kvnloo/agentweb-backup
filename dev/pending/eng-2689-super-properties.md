## ENG-2689: super properties attached to every tracked event (2026-10-26)

- `backend/src/utils/superProperties.ts`: fixed 40-property table from the hireemma.ai tracking plan
  ("#super properties" tab) with typed, bounded parsing; stored as `super.<name>` fields.
- Ingest stores them only for lists with an ENG-2688 allow-list; `#ip` is never accepted from the browser.
- `aw.js`: presets (`#event_time`, `#lib`, `#device_id`, `#url`, `#referrer`, `#title`, `#ua`,
  `#system_language`, screen, `#zone_offset`, `site_domain`, `session_page_num`) plus
  `window.awSuper` / `awRegister({...})` registered values ride every event as `super`.
