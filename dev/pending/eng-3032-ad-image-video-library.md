## ENG-3032: Zoma ads_get_ad_images + ads_get_ad_videos (2026-11-15)

- New module `backend/src/mcp/metaToolkitAssetLibrary.ts` with two read-only tools. `ads_get_ad_images` reads `act_<id>/adimages`; `ads_get_ad_videos` reads `act_<id>/advideos`. Both edges are documented under developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/ (`adimages`, `advideos`).
- No existing Zoma operation listed either library (`adimages` was only used for upload, `advideos` not at all outside the sandbox simulator), so both rows needed a tool.
- One page per call. Graph's `paging.next` URL contains the access token, so the tools hand back only the `after` cursor, and only when Meta reports a next page. The cursor argument must match `[A-Za-z0-9_-=]{1,512}` so it cannot carry a second query parameter.
- `Video.status` is an object; the tool returns `status.video_status` (ready / processing / error). The Video node's field list was not confirmed from Meta's reference page (it did not load); `id,title,status,length,picture` are long-standing Graph Video fields.
- Wiring a new toolkit module takes five edits: manifest (definitions + v1 guard), gateway branch, `READ_ONLY_TOOLKIT_TOOLS`, the edge allow-list in `agentModeService.readToolkitMetaAccountGraph`, and the expected-names list in `eng2282.metaToolkitManifest.test.ts`.
- Nothing was run against a live Meta account.
