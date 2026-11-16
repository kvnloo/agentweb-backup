export interface AdminTabDefinition {
  slug: string;
  value: number;
  label: string;
}

export interface AdminNavigationSection {
  label: string;
  tabs: readonly AdminTabDefinition[];
}

const tab = (slug: string, value: number, label: string): AdminTabDefinition => ({ slug, value, label });

export const ADMIN_NAVIGATION_SECTIONS: readonly AdminNavigationSection[] = [
  { label: 'Overview', tabs: [tab('overview', 0, 'Overview'), tab('announcements', 1, 'Announcements')] },
  { label: 'People & access', tabs: [tab('users', 2, 'Users'), tab('waitlist', 3, 'Waitlist'), tab('contractors', 22, 'Contractors'), tab('connected-accounts', 21, 'Connected Accounts')] },
  { label: 'Product ops', tabs: [tab('tasks', 4, 'Tasks'), tab('workflows', 5, 'Workflows'), tab('chat-history', 6, 'Chat History'), tab('knowledge-base', 7, 'Knowledge Base'), tab('agent-mode', 8, 'Agent Mode')] },
  { label: 'AI configuration', tabs: [tab('image-models', 9, 'Image Models (Legacy)'), tab('default-prompts', 10, 'Default Prompts'), tab('benchmarks', 11, 'Benchmarks'), tab('scoring-judges', 15, 'Scoring Judges'), tab('eval-v2', 26, 'Eval v2'), tab('mcp-servers', 13, 'MCP Servers'), tab('emma-mcp', 23, 'Emma MCP')] },
  { label: 'Revenue & billing', tabs: [tab('subscriptions', 12, 'Subscriptions'), tab('revenue', 17, 'Revenue'), tab('costs', 24, 'LLM Costs'), tab('usage-cost', 25, 'Usage & Cost'), tab('vendor-rates', 27, 'Vendor Rates')] },
  { label: 'Growth & CRM', tabs: [tab('crm', 16, 'CRM'), tab('funnel', 18, 'Funnel'), tab('onboarding', 20, 'Onboarding'), tab('zoma', 28, 'Zoma')] },
  { label: 'Ops & alerts', tabs: [tab('result-endpoints', 14, 'Result Endpoints'), tab('alert-emails', 19, 'Alert Emails')] },
];

export const ADMIN_TABS: readonly AdminTabDefinition[] = ADMIN_NAVIGATION_SECTIONS.flatMap(({ tabs }) => tabs);

export const ADMIN_TAB_MAP = Object.fromEntries(ADMIN_TABS.map(({ slug, value }) => [slug, value])) as Readonly<Record<string, number>>;
