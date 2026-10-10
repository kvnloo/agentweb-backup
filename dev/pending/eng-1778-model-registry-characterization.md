## ENG-1778: model registry characterization fixture (2026-10-10)

Added a byte-for-byte characterization test of `getSupportedModelsWithMetadata()` (admin: 44 models, non-admin: 36) with a committed JSON fixture, before any AW-ModelRegistry read-path change. Test-only; no runtime change. AC2-4 (backfill and table read path) remain data-plane gated on ENG-1776.
