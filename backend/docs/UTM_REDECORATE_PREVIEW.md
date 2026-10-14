# UTM redecorate preview (ENG-728)

Preview only. There is no apply flag, deployment call, or storage mutation.
Run the compiled script from the deployed backend release with read-only AWS
credentials (Query on AW-LandingPages/UserIdIndex and the normal user lookup):

```sh
NODE_ENV=production node dist/scripts/preview-lander-utm.js USER_ID deployed-links.json
```

The second argument is an **observed deployed-link inventory**, not links inferred
from a newer repository main. Capture links from the deployed artifact/browser
for each lander, preserving its absolute URL and a stable source/DOM location.
Do not execute unfamiliar downloaded page scripts inside the operator process.
Inventory format:

```json
{
  "userId": "USER_ID",
  "landers": {
    "LANDER_ID": [
      { "location": "app/page.tsx:12", "href": "https://example.com/demo?utm_source=old&gclid=keep" }
    ]
  }
}
```

The CLI paginates the production lander records, uses the user's stored default,
and calls the existing per-lander preview service. Missing snapshot entries are
error rows, never silently treated as zero links. A genuine zero-link deployed
artifact must be captured explicitly as `[]`. Corrupt overrides/defaults remain
errors. Optional trailing lander IDs explicitly select overrides for preview;
they do not enable writes. Missing explicitly selected records produce error rows.

Output on stdout contains each lander status and exact before/after URLs plus
added/updated/removed parameters. Error rows also cause exit code 1. Repeating the
same observations is deterministic and writes no state. Use read-only credentials
as a second boundary. Live bulk apply remains a separate Harsha-approved operation.

Limits: link observation/capture is an operator input, not an automatic website
crawler; freshness/completeness of that observation is the operator's responsibility.
The preview does not assert that a live deployment has been changed.
