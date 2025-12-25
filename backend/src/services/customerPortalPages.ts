/**
 * Customer Portal Pages Configuration
 * This file defines all available pages in the customer portal.
 * When new pages are added to the customer portal, they should be added here.
 */

export interface CustomerPortalPage {
  path: string; // Full path relative to /marketing (e.g., "/research" or "/research/:taskId")
  label: string; // Human-readable label
  description?: string; // Optional description
}

/**
 * All available customer portal pages
 * These are the pages that appear in the sidebar of customer-portal/src/components/layout/Layout.tsx
 * 
 * IMPORTANT: When adding new pages to the customer portal sidebar, add them here as well.
 * The paths should match the route paths defined in customer-portal/src/App.tsx
 * 
 * Note: The following pages are always available regardless of subscription type:
 * - / (Agent Mode home)
 * - /agent-mode (Agent Mode)
 * - /settings (Settings)
 * - /guide (User Guide)
 * 
 * All other pages listed here can be restricted by subscription type.
 */
export const CUSTOMER_PORTAL_PAGES: CustomerPortalPage[] = [
  {
    path: '/brand-guidelines',
    label: 'Brand Guidelines',
    description: 'Manage brand data and assets'
  },
  {
    path: '/market-strategy',
    label: 'Market Strategy',
    description: 'Manage business overview, competitors, and ICPs'
  },
  {
    path: '/gtm-plan',
    label: 'GTM Plan',
    description: 'Go-to-market planning'
  },
  {
    path: '/meta-campaigns',
    label: 'Campaign Performance',
    description: 'View Meta ad campaign performance'
  },
  {
    path: '/paid-social',
    label: 'Paid Social',
    description: 'View paid social media campaign performance'
  },
  {
    path: '/newsletter',
    label: 'Newsletter',
    description: 'View newsletter campaign performance'
  },
  {
    path: '/seo',
    label: 'SEO/GEO',
    description: 'SEO and analytics management'
  },
  {
    path: '/research-reports',
    label: 'Reports',
    description: 'View market research reports'
  },
  {
    path: '/email-templates',
    label: 'Email Templates',
    description: 'Create and manage email templates'
  },
  {
    path: '/knowledge-base',
    label: 'Knowledge Base',
    description: 'Manage knowledge base files'
  },
  {
    path: '/crm',
    label: 'CRM',
    description: 'Customer relationship management'
  },
  {
    path: '/images',
    label: 'Ad Images',
    description: 'Image generation and management'
  },
  {
    path: '/videos',
    label: 'Ad Videos',
    description: 'Video generation and management'
  },
  {
    path: '/books',
    label: 'Books',
    description: 'Create and manage books'
  },
  {
    path: '/tasks',
    label: 'Tasks',
    description: 'View and manage tasks'
  }
];

/**
 * Get all available customer portal pages
 */
export function getCustomerPortalPages(): CustomerPortalPage[] {
  return CUSTOMER_PORTAL_PAGES;
}

/**
 * Get page label by path
 */
export function getPageLabel(path: string): string {
  // Handle default pages
  if (path === '/' || path === '/agent-mode') {
    return 'Agent Mode';
  }
  if (path === '/settings') {
    return 'Settings';
  }
  if (path === '/guide') {
    return 'User Guide';
  }
  
  // Try to find exact match first
  const exactPage = CUSTOMER_PORTAL_PAGES.find(p => p.path === path);
  if (exactPage) {
    return exactPage.label;
  }
  
  // Try to match paths with parameters (e.g., /tasks/:taskId)
  const page = CUSTOMER_PORTAL_PAGES.find(p => {
    const pagePathPattern = p.path.replace(/:[^/]+/g, '[^/]+');
    const regex = new RegExp(`^${pagePathPattern}$`);
    return regex.test(path);
  });
  
  return page?.label || path;
}
