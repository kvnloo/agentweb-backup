export interface EscalationEvent {
  loopId: string;
  loopName: string;
  error: string;
  runId: string;
  priority: 'High' | 'Critical';
  title: string;
  createdAt: string;
}

export interface EscalationConfig {
  onEscalate: (event: EscalationEvent) => Promise<void>;
  criticalThreshold?: number; // consecutive failures before escalating to Critical
}

export class LoopEscalationService {
  private config: EscalationConfig;
  private failureCounts: Map<string, number> = new Map();

  constructor(config: EscalationConfig) {
    this.config = config;
  }

  async escalate(params: {
    loopId: string;
    loopName: string;
    error: string;
    runId: string;
  }): Promise<void> {
    if (!params.loopId) {
      throw new Error('loopId is required');
    }
    if (!params.error) {
      throw new Error('error is required');
    }

    const count = (this.failureCounts.get(params.loopId) || 0) + 1;
    this.failureCounts.set(params.loopId, count);

    const threshold = this.config.criticalThreshold || 3;
    const priority = count >= threshold ? 'Critical' : 'High';

    const event: EscalationEvent = {
      loopId: params.loopId,
      loopName: params.loopName,
      error: params.error,
      runId: params.runId,
      priority,
      title: `Loop "${params.loopName}" failed — ${params.error.substring(0, 100)}`,
      createdAt: new Date().toISOString(),
    };

    await this.config.onEscalate(event);
  }

  reportSuccess(loopId: string): void {
    this.failureCounts.set(loopId, 0);
  }
}
