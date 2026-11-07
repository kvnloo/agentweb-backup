## ENG-2834: Org-shared Creatives (2026-11-07)

Added `creatives` org share feature (default on, member-owned toggle). Creatives with-images/with-videos/with-html-reports endpoints fan out org members' assets when on, stamped `ownerUserId`/`sharedFromOrg`; caller-only when off, no org, or org lookup fails. Excluded from member-removal ownership cleanup. No schema/data migration.
