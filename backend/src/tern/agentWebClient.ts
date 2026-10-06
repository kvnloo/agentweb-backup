import axios, { AxiosInstance } from 'axios';
import type { ApprovalDeckInboundAnswer, EmmaSessionLike } from './renderEmma';

export type EmmaStreamEvent =
  | { type: 'tool_start'; name: string }
  | {
      type: 'complete';
      content?: string;
      toolCalls?: unknown[];
      session?: EmmaSessionLike | null;
      error?: boolean;
      [key: string]: unknown;
    }
  | { type: string; [key: string]: unknown };

export interface AgentWebClientOptions {
  baseUrl: string;
  token: string;
}

export class AgentWebClient {
  private readonly http: AxiosInstance;

  constructor(options: AgentWebClientOptions) {
    this.http = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
      timeout: 0,
    });
  }

  async listEmmaSessions(limit = 20): Promise<EmmaSessionLike[]> {
    const response = await this.http.get('/api/chatbot/sessions/emma', {
      params: { limit, pageIdentifier: 'customer-portal' },
    });
    return Array.isArray(response.data) ? response.data as EmmaSessionLike[] : [];
  }

  async getSession(sessionId: string): Promise<EmmaSessionLike> {
    const response = await this.http.get(
      `/api/chatbot/sessions/${encodeURIComponent(sessionId)}`,
    );
    return response.data as EmmaSessionLike;
  }

  async createSession(): Promise<EmmaSessionLike> {
    const response = await this.http.post(
      '/api/chatbot/sessions',
      { pageIdentifier: 'customer-portal' },
      { params: { portal: 'customer' } },
    );
    return response.data as EmmaSessionLike;
  }

  async submitApprovalDeck(
    session: EmmaSessionLike,
    deckId: string,
    answers: ApprovalDeckInboundAnswer[],
  ): Promise<EmmaSessionLike> {
    const delegated = answers.length > 0 && answers.every(answer => answer.delegated === true);
    const approved = answers.filter(answer => answer.verdict === 'approve').length;
    const rejected = answers.filter(answer => answer.verdict === 'reject').length;
    const label = delegated
      ? 'Let Emma decide'
      : `Reviewed ${answers.length} item${answers.length === 1 ? '' : 's'}${approved || rejected ? ` — ${approved} approved, ${rejected} rejected` : ''}`;

    await this.http.post('/api/agent-mode/generate', {
      sessionId: session.sessionId,
      userMessage: label,
      llmModel: session.llmModel,
      attachments: [],
      deckAnswer: {
        deckId,
        answers,
      },
    });

    return this.getSession(session.sessionId);
  }

  async streamMessage(
    sessionId: string,
    message: string,
    onEvent: (event: EmmaStreamEvent) => void,
  ): Promise<Extract<EmmaStreamEvent, { type: 'complete' }>> {
    const response = await this.http.post(
      `/api/chatbot/sessions/${encodeURIComponent(sessionId)}/messages/stream`,
      { message },
      {
        params: { portal: 'customer' },
        responseType: 'stream',
        headers: { Accept: 'text/event-stream' },
      },
    );

    let buffer = '';
    let complete: Extract<EmmaStreamEvent, { type: 'complete' }> | undefined;
    const stream = response.data as AsyncIterable<Buffer | string>;

    const consumeBlock = (block: string) => {
      const dataLines = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart());

      if (dataLines.length === 0) return;

      const payload = dataLines.join('\n');
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

      const event = parsed as EmmaStreamEvent;
      onEvent(event);
      if (event.type === 'complete') {
        complete = event as Extract<EmmaStreamEvent, { type: 'complete' }>;
      }
    };

    for await (const chunk of stream) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consumeBlock(block);
      }
    }

    if (buffer.trim()) consumeBlock(buffer);

    if (!complete) {
      throw new Error('Emma stream ended without a complete event');
    }
    return complete;
  }
}
