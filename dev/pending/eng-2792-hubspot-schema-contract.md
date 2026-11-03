## ENG-2792: call_hubspot_api schema/handler contract (2026-11-03)

Added CONTACTS to the declared entity_type enum (handler already dispatches it), uppercase entity_type/action, and map recognizable raw-REST `endpoint` calls to entity_type+LIST in normalizeHubSpotArgs. Shapes taken from Dev-AW-LoopEvents failedArgsJson.
