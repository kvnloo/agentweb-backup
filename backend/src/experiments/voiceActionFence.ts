export interface VoiceActionToken {
  sessionId: string;
  sequence: number;
}

export class VoiceActionFence {
  private latest = new Map<string, number>();
  private publishing = new Set<string>();

  issue(sessionId: string): VoiceActionToken {
    const sequence = (this.latest.get(sessionId) ?? 0) + 1;
    this.latest.set(sessionId, sequence);
    return { sessionId, sequence };
  }

  canCommit(token: VoiceActionToken): boolean {
    return this.latest.get(token.sessionId) === token.sequence;
  }

  beginPublish(token: VoiceActionToken): boolean {
    if (!this.canCommit(token) || this.publishing.has(token.sessionId)) return false;
    this.publishing.add(token.sessionId);
    return true;
  }

  endPublish(token: VoiceActionToken): void {
    this.publishing.delete(token.sessionId);
  }

  isPublishing(sessionId: string): boolean {
    return this.publishing.has(sessionId);
  }
}
