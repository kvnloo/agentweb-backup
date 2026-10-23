import axios, { AxiosInstance } from 'axios';
import type { OperatorActivity, OperatorExecution, OperatorTask } from './operatorModel';

/** Uses the existing authenticated task endpoints and authorization gates. */
export class AgentWebOperatorClient {
  private readonly http: AxiosInstance;

  constructor(options: { baseUrl: string; token: string }) {
    this.http = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      headers: {
        Authorization: 'Bearer ' + options.token,
        Accept: 'application/json',
      },
      timeout: 15000,
    });
  }

  async listTasks(): Promise<OperatorTask[]> {
    const { data } = await this.http.get('/api/tasks');
    if (!Array.isArray(data)) throw new Error('Unexpected tasks response');
    return data.filter((item): item is OperatorTask =>
      item !== null && typeof item === 'object'
      && typeof item.taskId === 'string' && typeof item.name === 'string'
      && typeof item.status === 'string');
  }

  async listExecutions(taskId: string): Promise<OperatorExecution[]> {
    const { data } = await this.http.get(
      '/api/tasks/' + encodeURIComponent(taskId) + '/executions',
    );
    if (!Array.isArray(data)) throw new Error('Unexpected executions response');
    return data.filter((item): item is OperatorExecution =>
      item !== null && typeof item === 'object'
      && item.taskId === taskId && typeof item.executionId === 'string'
      && typeof item.status === 'string');
  }

  async getExecution(taskId: string, executionId: string): Promise<OperatorExecution> {
    const { data } = await this.http.get(
      '/api/tasks/' + encodeURIComponent(taskId) + '/executions/' + encodeURIComponent(executionId),
    );
    if (!data || data.taskId !== taskId || data.executionId !== executionId
        || typeof data.status !== 'string') {
      throw new Error('Unexpected execution response');
    }
    return data as OperatorExecution;
  }

  /**
   * The existing detail read retains the server's task authorization boundary.
   * The additive /activity route separately authorizes each bounded S3 read.
   * No raw log, log URL or access token is returned by that activity route.
   */
  async getExecutionWithActivity(taskId: string, executionId: string): Promise<OperatorExecution> {
    const execution = await this.getExecution(taskId, executionId);
    if (!execution.browser_use_log) return { ...execution, activity: [] };
    try {
      const { data } = await this.http.get(
        '/api/tasks/' + encodeURIComponent(taskId) + '/executions/'
          + encodeURIComponent(executionId) + '/activity',
      );
      if (!data || data.source !== 'browser-log' || !Array.isArray(data.events)) {
        throw new Error('Unexpected activity response');
      }
      const events: OperatorActivity[] = data.events.slice(-40).filter(
        (item: any): item is OperatorActivity =>
          item && typeof item.id === 'string' && /^browser\.[0-9a-f]{20}\.[0-9]+$/.test(item.id)
          && typeof item.when === 'string' && item.when.length <= 50
          && ['step', 'action', 'log'].includes(item.kind)
          && ['INFO', 'WARNING', 'ERROR'].includes(item.level)
          && typeof item.summary === 'string' && item.summary.length <= 120,
      ).map((item: OperatorActivity) => ({
        id: item.id, when: item.when, kind: item.kind,
        level: item.level, summary: item.summary,
      }));
      return { ...execution, activity: events };
    } catch {
      // Never replace a valid execution with a guessed activity event or with
      // an error body's potentially sensitive text. The next poll can recover.
      return { ...execution, activity: [], activityUnavailable: true };
    }
  }

  async startTask(taskId: string): Promise<OperatorExecution> {
    const { data } = await this.http.post(
      '/api/tasks/' + encodeURIComponent(taskId) + '/execute', {},
    );
    if (!data || data.taskId !== taskId || typeof data.executionId !== 'string') {
      throw new Error('Unexpected task execution response');
    }
    return data as OperatorExecution;
  }

  async stopExecution(taskId: string, executionId: string): Promise<OperatorExecution> {
    // The server re-checks status and ownership at the mutation boundary.
    // This read is only an additional UI freshness guard.
    const live = await this.getExecution(taskId, executionId);
    if (live.status.toLowerCase() !== 'running') {
      throw new Error('The run is no longer running; stop was not sent');
    }
    const { data } = await this.http.put(
      '/api/tasks/' + encodeURIComponent(taskId) + '/executions/'
        + encodeURIComponent(executionId) + '/kill', {},
    );
    if (!data || data.taskId !== taskId || data.executionId !== executionId) {
      throw new Error('Unexpected stop response');
    }
    return data as OperatorExecution;
  }
}
