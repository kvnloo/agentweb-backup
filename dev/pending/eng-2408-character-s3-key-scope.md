## ENG-2408: Scope character reference image keys to caller's S3 prefix (2026-10-12)

POST /api/characters rejects referenceImageKey outside `users/{userId}/files/`; DELETE only removes S3 objects under the caller's prefix (row still deleted). No schema change.
