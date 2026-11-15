## ENG-2995: Campaign conversion goal UPDATE no longer refuses non-biddable goals as not found (2026-11-13)

Google Ads REST omits `biddable` when false; the MCP toolkit read mapper now treats an omitted field as false instead of a missing row.
