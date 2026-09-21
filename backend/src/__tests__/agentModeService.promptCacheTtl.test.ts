/**
 * Prompt caching is now an OpenRouter request concern. These tests preserve
 * the user-visible cache behavior without coupling AgentMode to Bedrock's
 * Converse payload or provider-specific cache accounting.
 */

import { AgentModeService } from '../services/agentModeService';
import { applyOpenRouterCacheBreakpoints } from '../utils/openRouterGatewayContract';

const CONVERSATION = [
  { role: 'system', content: 'System prompt here' },
  { role: 'user', content: 'First message' },
  { role: 'assistant', content: 'First response' },
  { role: 'user', content: 'Second message' },
];

describe('ENG-893 — OpenRouter prompt-cache TTL', () => {
  it('adds independent 1-hour cache points to the system and conversation prefix', () => {
    const result = applyOpenRouterCacheBreakpoints(CONVERSATION, true);
    const systemControl = result[0].content[0].cache_control;
    const prefixControl = result[2].content[0].cache_control;

    expect(systemControl).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(prefixControl).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(systemControl).not.toBe(prefixControl);
    expect(CONVERSATION[0].content).toBe('System prompt here');
  });

  it('uses the default cache TTL when a turn is not human-paced', () => {
    const result = applyOpenRouterCacheBreakpoints(CONVERSATION, false);

    expect(result[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(result[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('adds a cache point to a short one-shot request', () => {
    const result = applyOpenRouterCacheBreakpoints([
      { role: 'user', content: 'One request' },
    ], true);

    expect(result[0].content).toEqual([{
      type: 'text',
      text: 'One request',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }]);
  });

  describe('longestUserPauseMs', () => {
    const at = (iso: string, role: string) => ({ role, content: 'x', timestamp: iso });

    it('measures the greatest user pause from message history', () => {
      expect(AgentModeService.longestUserPauseMs([
        at('2026-08-05T10:00:00.000Z', 'user'),
        at('2026-08-05T10:00:30.000Z', 'assistant'),
        at('2026-08-05T10:12:00.000Z', 'user'),
        at('2026-08-05T10:12:05.000Z', 'assistant'),
        at('2026-08-05T10:13:00.000Z', 'user'),
      ])).toBe(11.5 * 60 * 1000);
    });

    it('returns zero for missing, invalid, or backward timestamps', () => {
      expect(AgentModeService.longestUserPauseMs([])).toBe(0);
      expect(AgentModeService.longestUserPauseMs([
        { role: 'user', content: 'x' },
        at('2026-08-05T10:10:00.000Z', 'user'),
      ] as any)).toBe(0);
      expect(AgentModeService.longestUserPauseMs([
        at('not-a-date', 'user'),
        at('2026-08-05T10:00:00.000Z', 'user'),
      ])).toBe(0);
      expect(AgentModeService.longestUserPauseMs([
        at('2026-08-05T10:10:00.000Z', 'user'),
        at('2026-08-05T10:00:00.000Z', 'user'),
      ])).toBe(0);
    });
  });
});
