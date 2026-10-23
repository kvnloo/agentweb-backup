import axios, { AxiosInstance } from 'axios';
import type { OperatorExecution, OperatorTask } from './operatorModel';

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
