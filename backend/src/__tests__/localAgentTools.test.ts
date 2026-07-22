/**
 * ENG-383 — local agent relay tools are DEPRECATED stubs.
 *
 * The relay (ngrok tunnel to a Codex agent on a Mac) is permanently dead
 * (ERR_NGROK_6008, account suspended). Behavioral contract this suite pins:
 *   1. Both tools stay REGISTERED (legacy skills / forced calls must not hit
 *      an opaque "tool not found").
 *   2. Each call fails fast with the clear local_agent_deprecated error —
 *      immediately, with NO network, NO Secrets Manager, NO S3.
 *   3. Descriptions are marked DEPRECATED so the model never picks them.
 */
import * as https from 'https';
import * as http from 'http';

jest.mock('https', () => ({ request: jest.fn(() => { throw new Error('network call from deprecated stub'); }) }));
jest.mock('http', () => ({ request: jest.fn(() => { throw new Error('network call from deprecated stub'); }) }));
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(() => { throw new Error('Secrets Manager call from deprecated stub'); }),
  secretExists: jest.fn(() => { throw new Error('Secrets Manager call from deprecated stub'); }),
}));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(() => { throw new Error('S3 call from deprecated stub'); }),
}));

import { LOCAL_AGENT_DEPRECATION_ERROR } from '../emma/localAgentTools';
import { emmaToolRegistry } from '../emma/registry';
import { getSecret, secretExists } from '../utils/secretsManager';
import { uploadFileToS3 } from '../utils/s3Utils';

const DEPRECATED_TOOLS = ['run_local_agent_task', 'check_local_agent_status'] as const;

describe('local agent tools are deprecated stubs (ENG-383)', () => {
  describe.each(DEPRECATED_TOOLS)('%s', (toolName) => {
    it('is still registered in the Emma tool registry', () => {
      expect(emmaToolRegistry.getTool(toolName)).toBeDefined();
    });

    it('marks its description DEPRECATED and points at you_search_web', () => {
      const definition = emmaToolRegistry.getTool(toolName)!.definition;
      expect(definition.name).toBe(toolName);
      expect(definition.description).toMatch(/^DEPRECATED \(2026-07\):/);
      expect(definition.description).toContain('you_search_web');
    });

    it('returns the deprecation error immediately', async () => {
      const startedAt = Date.now();
      const result = await emmaToolRegistry.execute(toolName, { task: 'visit https://example.com' }, { userId: 'u1' });
      expect(result).toEqual({ success: false, error: LOCAL_AGENT_DEPRECATION_ERROR });
      expect(Date.now() - startedAt).toBeLessThan(1000);
    });

    it('makes no network, Secrets Manager, or S3 calls', async () => {
      await emmaToolRegistry.execute(toolName, {}, { userId: 'u1' });
      expect(https.request).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
      expect(getSecret).not.toHaveBeenCalled();
      expect(secretExists).not.toHaveBeenCalled();
      expect(uploadFileToS3).not.toHaveBeenCalled();
    });
  });

  it('names the retirement, the replacement, and the tracking issue in the error', () => {
    expect(LOCAL_AGENT_DEPRECATION_ERROR).toMatch(/^local_agent_deprecated:/);
    expect(LOCAL_AGENT_DEPRECATION_ERROR).toContain('retired in July 2026');
    expect(LOCAL_AGENT_DEPRECATION_ERROR).toContain('you_search_web');
    expect(LOCAL_AGENT_DEPRECATION_ERROR).toContain('you_search_news');
    expect(LOCAL_AGENT_DEPRECATION_ERROR).toContain('ENG-381');
  });
});
