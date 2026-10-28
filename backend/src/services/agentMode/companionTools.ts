// ENG-896: read-only companion tools granted alongside their primary tool.
// get_ga4_key_events shares get_website_analytics' GA4 credentials and scope.
// Seeded skills such as the daily digest list only the analytics tool, whose
// guidance points at key events, so granting one grants the pair.
const COMPANION_TOOLS: Record<string, string[]> = {
  get_website_analytics: ['get_ga4_key_events'],
};

export function addCompanionTools(allowedToolNames: Set<string>): void {
  for (const [primary, companions] of Object.entries(COMPANION_TOOLS)) {
    if (allowedToolNames.has(primary)) companions.forEach(c => allowedToolNames.add(c));
  }
}
