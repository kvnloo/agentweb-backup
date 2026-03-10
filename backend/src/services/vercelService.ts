/**
 * Vercel API service for managing landing page deployments.
 * Handles listing deployments, getting deployment details, and promoting to production.
 */

const VERCEL_API_BASE = 'https://api.vercel.com';

interface VercelDeployment {
  uid: string;
  url: string;
  state: string;
  createdAt: number;
  name?: string;
  meta?: Record<string, string>;
}

function getHeaders(): Record<string, string> {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) {
    throw new Error('VERCEL_API_TOKEN environment variable is not set');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function teamQuery(): string {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${teamId}` : '';
}

class VercelService {
  /**
   * List recent deployments for a Vercel project.
   */
  async listDeployments(projectId: string, limit = 20): Promise<VercelDeployment[]> {
    const tq = teamQuery();
    const url = `${VERCEL_API_BASE}/v6/deployments${tq}${tq ? '&' : '?'}projectId=${projectId}&limit=${limit}`;
    const response = await fetch(url, { headers: getHeaders() });

    if (!response.ok) {
      throw new Error(`Vercel API error (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    return data.deployments || [];
  }

  /**
   * Get details of a specific deployment by ID.
   */
  async getDeployment(deploymentId: string): Promise<VercelDeployment> {
    const url = `${VERCEL_API_BASE}/v13/deployments/${deploymentId}${teamQuery()}`;
    const response = await fetch(url, { headers: getHeaders() });

    if (!response.ok) {
      throw new Error(`Vercel API error (${response.status}): ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Promote a preview deployment to production by creating an alias.
   * Takes the deployment URL and promotes it.
   */
  async promoteToProduction(deploymentUrl: string): Promise<{ url: string }> {
    // Extract deployment ID from URL or use directly
    // Vercel deployment URLs look like: project-name-abc123.vercel.app
    // We need to find the deployment by its URL first

    const tq = teamQuery();
    const findUrl = `${VERCEL_API_BASE}/v13/deployments/get${tq}${tq ? '&' : '?'}url=${encodeURIComponent(deploymentUrl.replace('https://', ''))}`;
    const findResponse = await fetch(findUrl, { headers: getHeaders() });

    if (!findResponse.ok) {
      throw new Error(`Failed to find deployment: ${await findResponse.text()}`);
    }

    const deployment = await findResponse.json();

    // Promote via the Vercel promote API
    const promoteUrl = `${VERCEL_API_BASE}/v10/projects/${deployment.projectId}/promote/${deployment.uid}${teamQuery()}`;
    const promoteResponse = await fetch(promoteUrl, {
      method: 'POST',
      headers: getHeaders(),
    });

    if (!promoteResponse.ok) {
      throw new Error(`Failed to promote deployment: ${await promoteResponse.text()}`);
    }

    return { url: `https://${deployment.url}` };
  }
}

export const vercelService = new VercelService();
