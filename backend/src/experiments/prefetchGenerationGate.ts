export type PrefetchAdmission = 'admit' | 'stale' | 'too_large';

export class PrefetchGenerationGate {
  private generations = new Map<string, number>();

  start(scope: string): number {
    const next = (this.generations.get(scope) ?? 0) + 1;
    this.generations.set(scope, next);
    return next;
  }

  current(scope: string): number {
    return this.generations.get(scope) ?? 0;
  }

  canCommit(scope: string, generation: number): boolean {
    return generation === this.current(scope);
  }

  admit(params: {
    scope: string;
    generation: number;
    chars: number;
    maxChars: number;
  }): PrefetchAdmission {
    if (!this.canCommit(params.scope, params.generation)) return 'stale';
    if (params.chars > params.maxChars) return 'too_large';
    return 'admit';
  }
}
