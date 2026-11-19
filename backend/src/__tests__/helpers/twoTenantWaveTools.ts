/**
 * The MCP tools that read or change tenant data AND are covered by the two-tenant isolation matrix
 * (mcp.twoTenantIsolation.test.ts). A wave that adds or changes such a tool adds its name here AND its cases to the matrix in the same PR:
 * the matrix fails when this list and its cases disagree, or when a listed tool is no longer registered.
 */
export const TWO_TENANT_COVERED_TOOLS = [
  'manage_leads',
  'list_lead_lists',
  'create_lead_list',
  'manage_brand',
  'manage_market_strategy',
] as const;

export type TwoTenantCoveredTool = (typeof TWO_TENANT_COVERED_TOOLS)[number];
