# Ads Auto Publisher — dry-run demo (ENG-2430)

Internal engineering walkthrough for the standalone, Emma-independent Meta publisher.
**Nothing is published.** There is no Meta token, no Graph API call, and no network I/O
(enforced by `src/__tests__/eng2430.adsPublisherDemo.test.ts`). Every planned object is `PAUSED`.
This module is not mounted in `app.ts` and is not deployed. Partner-facing wording,
pricing claims, or a hosted URL need Harsha's copy review first.

## Input: campaign spec

`name`, `objective` (`OUTCOME_SALES|LEADS|TRAFFIC|AWARENESS|ENGAGEMENT|APP_PROMOTION`),
`dailyBudget` (major currency units), `audience` (`countries` ISO-2, `ageMin`, `ageMax`,
`genders`, `interests`), `creatives[]` (`primaryText`, `headline`, `imageUrl`, `linkUrl`,
`callToAction`).

## CLI

```
cd backend
npx ts-node src/adsPublisherDemo/cli.ts src/adsPublisherDemo/samples/ecommerce-sales.json
```

Exit 0 = plan printed, 2 = validation errors, 1 = usage/read error.

## Mock API

```
cd backend
npx ts-node src/adsPublisherDemo/server.ts        # http://127.0.0.1:4430
curl -s -X POST localhost:4430/v1/publish -d @src/adsPublisherDemo/samples/local-leads.json
```

`dryRun` is forced on (a body of `{"dryRun": false, "spec": {...}}` still dry-runs).
200 = valid plan, 422 = validation errors, 400 = bad JSON.

## Samples

| Spec | Output |
| --- | --- |
| `samples/ecommerce-sales.json` (2 creatives, interests) | `samples/ecommerce-sales.output.json` — campaign, ad set, 2 creatives, 2 ads |
| `samples/local-leads.json` (1 creative) | `samples/local-leads.output.json` — campaign, ad set, 1 creative, 1 ad |

Outputs reference `{campaign_1.id}`-style placeholders for IDs a real publisher would chain.
