import jwt from 'jsonwebtoken';

export interface BlogDraftRequest {
  feature_name: string;
  pr_title: string;
  pr_url: string;
  steps?: string[];
  screenshot_urls?: string[];
  notion_task_url?: string;
  description?: string;
}

export interface BlogDraftResult {
  sessionId: string;
  draft: string;
  status: 'completed' | 'failed';
}

interface BlogPostGeneratorConfig {
  baseUrl?: string;
  jwtSecret?: string;
  systemUserId: string;
}

export class BlogPostGenerator {
  private config: BlogPostGeneratorConfig;

  constructor(config: BlogPostGeneratorConfig) {
    this.config = config;
  }

  private generateToken(): string {
    const secret = this.config.jwtSecret || process.env.JWT_SECRET || 'your-secret-key';
    return jwt.sign(
      { userId: this.config.systemUserId, email: 'system@agentweb.pro', isAdmin: true },
      secret,
      { expiresIn: 300 },
    );
  }

  private getBaseUrl(): string {
    return this.config.baseUrl || `http://localhost:${process.env.PORT || '3001'}`;
  }

  private buildPrompt(request: BlogDraftRequest): string {
    const parts: string[] = [
      `Please publish a draft blog post as a User Guide with the following details:`,
      ``,
      `Title: "How to ${request.feature_name}"`,
      `Category: User Guide`,
      ``,
      `Content structure:`,
      `1. **What's New** — ${request.description || request.pr_title}`,
    ];

    if (request.steps && request.steps.length > 0) {
      parts.push(`2. **Step-by-Step Guide**`);
      request.steps.forEach((step, i) => {
        parts.push(`   ${i + 1}. ${step}`);
      });
    } else {
      parts.push(`2. **Step-by-Step Guide** — [Describe the user flow based on the feature]`);
    }

    if (request.screenshot_urls && request.screenshot_urls.length > 0) {
      parts.push(`3. **Screenshots**`);
      request.screenshot_urls.forEach((url) => {
        parts.push(`   - ${url}`);
      });
    } else {
      parts.push(`3. **Screenshots** — [No screenshots provided]`);
    }

    parts.push(`4. **Tips** — [Any power-user notes, edge cases, or things to know]`);
    parts.push(``);
    parts.push(`Keep the language simple — write for a user who just signed up today.`);
    parts.push(`This should be a DRAFT, not published. The team will review before publishing.`);
    parts.push(``);
    parts.push(`Feature context:`);
    parts.push(`- PR: ${request.pr_url}`);
    if (request.notion_task_url) {
      parts.push(`- Notion task: ${request.notion_task_url}`);
    }

    return parts.join('\n');
  }

  async generate(request: BlogDraftRequest): Promise<BlogDraftResult> {
    // Validate required fields
    if (!request.feature_name) {
      throw new Error('feature_name is required');
    }
    if (!request.pr_title) {
      throw new Error('pr_title is required');
    }

    const token = this.generateToken();
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };
    const baseUrl = this.getBaseUrl();

    // Step 1: Create Emma session
    const sessionRes = await fetch(`${baseUrl}/api/agent-mode/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });

    if (!sessionRes.ok) {
      const errBody = await sessionRes.json().catch(() => ({}));
      throw new Error(`Blog draft session creation failed (${sessionRes.status}): ${errBody.error || 'Unknown error'}`);
    }

    const sessionData = await sessionRes.json();
    const sessionId = sessionData.sessionId;

    // Step 2: Send the blog draft prompt
    const prompt = this.buildPrompt(request);
    const messageRes = await fetch(`${baseUrl}/api/agent-mode/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId,
        userMessage: prompt,
      }),
    });

    if (!messageRes.ok) {
      const errBody = await messageRes.json().catch(() => ({}));
      throw new Error(`Blog draft message send failed (${messageRes.status}): ${errBody.error || 'Unknown error'}`);
    }

    const messageData = await messageRes.json();
    const draft = messageData.response || JSON.stringify(messageData);

    return {
      sessionId,
      draft: typeof draft === 'string' ? draft : JSON.stringify(draft),
      status: 'completed',
    };
  }
}
