import {
  buildReliabilityEvent,
  classifyToolResultOutcome,
  validateReliabilityEvent,
} from '../services/reliabilityEvent';
import {
  getReliabilityEventSink,
  recordReliabilityEventSafe,
  setReliabilityEventSinkForTests,
} from '../services/reliabilityEventSink';

describe('reliabilityEvent schema', () => {
  it('validates required fields', () => {
    const event = buildReliabilityEvent({ tool: 'jev_decide', outcome: 'success', latencyMs: 12 });
    expect(validateReliabilityEvent(event)).toBeNull();
  });

  it('classifies blocked and success tool results', () => {
    expect(classifyToolResultOutcome({ success: true })).toBe('success');
    expect(classifyToolResultOutcome({ success: false, message: 'Tool blocked by policy' })).toBe('blocked');
    expect(classifyToolResultOutcome({ skipped: true })).toBe('skipped');
    expect(classifyToolResultOutcome({ awaitingUserConfirmation: true })).toBe('pending_confirmation');
    expect(classifyToolResultOutcome({ requiresConfirmation: true })).toBe('pending_confirmation');
  });
});

describe('reliabilityEventSink', () => {
  afterEach(() => setReliabilityEventSinkForTests(null));

  it('records and drains events fail-open', () => {
    const sink = getReliabilityEventSink({ RELIABILITY_EVENT_SINK: 'memory' } as NodeJS.ProcessEnv);
    setReliabilityEventSinkForTests(sink);
    const recorded = recordReliabilityEventSafe({
      tool: 'post_on_connected_account',
      outcome: 'error',
      latencyMs: 40,
      sessionId: 's1',
      userId: 'u1',
      errorSummary: 'HTTP 500',
    });
    expect(recorded?.tool).toBe('post_on_connected_account');
    expect(sink.size()).toBe(1);
    expect(sink.drain()).toHaveLength(1);
    expect(sink.size()).toBe(0);
  });

  it('no-ops when sink is off', () => {
    const sink = getReliabilityEventSink({ RELIABILITY_EVENT_SINK: 'off' } as NodeJS.ProcessEnv);
    setReliabilityEventSinkForTests(sink);
    expect(recordReliabilityEventSafe({ tool: 'x', outcome: 'success', latencyMs: 1 })).toBeNull();
    expect(sink.size()).toBe(0);
  });
});
