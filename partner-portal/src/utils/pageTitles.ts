/**
 * Utility for getting human-readable page titles from routes
 */

// Map routes to friendly titles
const routeTitles: Record<string, string> = {
  '/': 'Home Page',
  '/dashboard': 'Dashboard',
  '/login': 'Login Page',
  '/register': 'Registration Page',
  '/tasks': 'Tasks Dashboard',
  '/tasks/create': 'Create New Task',
  '/templates': 'Templates Library',
  '/admin': 'Admin Dashboard',
  '/agent-runs': 'AgentRun Inspector',
  '/profile': 'User Profile',
  '/config': 'Configuration Page',
  '/workflows': 'Workflows Dashboard',
  '/workflows/new': 'Create New Workflow',
  '/api': 'API Documentation',
  '/marketing': 'Marketing Hub',
  '/marketing/research': 'Market Research List',
  '/marketing/social-listening': 'Social Listening Dashboard',
  '/marketing/creative-generation': 'Creative Generation Tools',
  '/marketing/blog': 'Marketing Blog',
};

/**
 * Get a user-friendly page title from a URL path
 */
export function getPageTitle(path: string): string {
  // Clean the path
  const cleanPath = path.replace(/\/+$/, '') || '/';
  
  // Check for exact match
  if (routeTitles[cleanPath]) {
    return routeTitles[cleanPath];
  }
  
  // Handle dynamic routes
  if (cleanPath.match(/^\/tasks\/[^/]+$/)) {
    const taskId = cleanPath.split('/').pop() || '';
    return `Task Details: ${taskId}`;
  }
  
  // Handle task execution details pattern
  if (cleanPath.match(/^\/tasks\/[^/]+\/executions\/[^/]+$/)) {
    const segments = cleanPath.split('/');
    const taskId = segments[2] || '';
    const executionId = segments[4] || '';
    return `Execution Details: ${executionId} (Task ${taskId})`;
  }
  
  if (cleanPath.match(/^\/workflows\/[^/]+$/)) {
    const workflowId = cleanPath.split('/').pop() || '';
    return `Workflow Details: ${workflowId}`;
  }

  // Handle workflow execution details pattern
  if (cleanPath.match(/^\/workflows\/[^/]+\/executions\/[^/]+$/)) {
    const segments = cleanPath.split('/');
    const executionId = segments[4] || '';
    return `Execution ${executionId} - Workflow Execution Details`;
  }
  
  if (cleanPath.match(/^\/marketing\/research\/[^/]+$/)) {
    const researchId = cleanPath.split('/').pop() || '';
    return `Market Research: ${researchId}`;
  }
  
  // Format path as fallback
  return formatPathToTitle(cleanPath);
}

/**
 * Format a URL path into a readable title
 */
function formatPathToTitle(path: string): string {
  // Extract the last part of the path
  const segment = path.split('/').filter(Boolean).pop() || 'Page';
  
  // Replace dashes and underscores with spaces
  let formatted = segment.replace(/[-_]/g, ' ');
  
  // Capitalize first letter of each word
  formatted = formatted.replace(/\b\w/g, c => c.toUpperCase());
  
  return formatted || 'Current Page';
} 
