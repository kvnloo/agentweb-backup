/**
 * ENG-2574: save_memory / save_org_memory split content over 2000 code points into
 * several rows instead of schema-rejecting it (8 live agent_tool_failed rows, 10-14..10-19).
 */
const mockAddMemory = jest.fn();
const mockAddOrgMemory = jest.fn();
const mockGetUser = jest.fn();
const mockGetOrg = jest.fn();

jest.mock('../services/db', () => ({
  accountMemoryDb: { addMemory: (...a: any[]) => mockAddMemory(...a) },
  orgMemoryDb: { addMemory: (...a: any[]) => mockAddOrgMemory(...a) },
  userDb: { getUserById: (...a: any[]) => mockGetUser(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrg(...a) },
  crmDb: {},
}));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/accountSummaryService', () => ({ getAccountSummary: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
}));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) } }));

import { emmaToolRegistry } from '../emma/registry';
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';
import { splitMemoryContent, memoryContentLength } from '../utils/memoryContentLimit';
import '../emma/tools';

const para = (n: number, ch: string) => `${ch.repeat(n - 1)}.`;

describe('ENG-2574 memory auto-split', () => {
  let n = 0;
  beforeEach(() => {
    n = 0;
    mockAddMemory.mockReset().mockImplementation(async () => ({ memoryId: `m${++n}` }));
    mockAddOrgMemory.mockReset().mockImplementation(async () => ({ memoryId: `o${++n}` }));
    mockGetUser.mockReset().mockResolvedValue({ userId: 'u1', orgId: 'org1' });
    mockGetOrg.mockReset().mockResolvedValue({ orgId: 'org1' });
  });

  describe('splitMemoryContent', () => {
    it('returns content within the cap unchanged as one chunk', () => {
      const c = 'x'.repeat(2000);
      expect(splitMemoryContent(c)).toEqual([c]);
    });

    it('splits at a paragraph boundary, every chunk within the cap, nothing lost', () => {
      const a = para(1500, 'a');
      const b = para(900, 'b');
      const chunks = splitMemoryContent(`${a}\n\n${b}`);
      expect(chunks).toEqual([a, b]);
    });

    it('hard-splits boundary-free content and counts code points', () => {
      const c = '😀'.repeat(4500);
      const chunks = splitMemoryContent(c);
      expect(chunks.length).toBe(3);
      chunks.forEach((ch) => expect(memoryContentLength(ch)).toBeLessThanOrEqual(2000));
      expect(chunks.join('')).toBe(c);
    });
  });

  it('save_memory within the cap makes exactly one addMemory call (AC1)', async () => {
    const tool = emmaToolRegistry.getTool('save_memory')!;
    const res: any = await tool.execute({ content: 'short fact', category: 'insight' }, { userId: 'u1', sessionId: 's1' });
    expect(mockAddMemory).toHaveBeenCalledTimes(1);
    expect(mockAddMemory).toHaveBeenCalledWith('u1', 'insight', 'short fact', 's1', undefined);
    expect(res).toEqual(expect.objectContaining({ success: true, memoryId: 'm1' }));
    expect(res.memoryIds).toBeUndefined();
  });

  it('save_memory over the cap passes the gateway and saves every chunk (AC2, AC4)', async () => {
    const tool = emmaToolRegistry.getTool('save_memory')!;
    const content = `${para(1900, 'a')}\n${para(300, 'b')}`; // 2201 chars, like the live rows
    const v = validateAndRepairToolArgs({
      toolName: 'save_memory', args: { content, category: 'workflow' },
      inputSchema: tool.definition.inputSchema, effect: 'internal_write',
    });
    expect(v.status).not.toBe('invalid');
    const res: any = await tool.execute(v.args as any, { userId: 'u1', sessionId: 's1' });
    expect(mockAddMemory).toHaveBeenCalledTimes(2);
    const saved = mockAddMemory.mock.calls.map((c) => c[2]);
    saved.forEach((c: string) => expect(memoryContentLength(c)).toBeLessThanOrEqual(2000));
    expect(saved.join('\n')).toBe(content);
    expect(res).toEqual(expect.objectContaining({ success: true, memoryId: 'm1', memoryIds: ['m1', 'm2'] }));
  });

  it('save_org_memory over the cap saves every chunk (AC3)', async () => {
    const tool = emmaToolRegistry.getTool('save_org_memory')!;
    const content = `${para(1900, 'a')}\n\n${para(300, 'b')}`;
    const res: any = await tool.execute({ content, category: 'insight' }, { userId: 'u1' });
    expect(mockAddOrgMemory).toHaveBeenCalledTimes(2);
    expect(mockAddOrgMemory.mock.calls.map((c) => c[2])).toEqual([para(1900, 'a'), para(300, 'b')]);
    expect(mockAddOrgMemory.mock.calls[0][0]).toBe('org1');
    expect(res.memoryIds).toEqual(['o1', 'o2']);
  });
});
