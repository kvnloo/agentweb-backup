/**
 * ENG-2140: scripts/scoreCreativeRubric.ts argument parsing and prior selection (CodeRabbit on #3081).
 */
import { evaluateCreativeGates } from '../services/creativeGates';
import { HumanEvalService, type HumanEvalCandidate } from '../services/humanEvalService';
import { parseArgs, priorBestFor } from '../scripts/scoreCreativeRubric';

describe('scoreCreativeRubric parseArgs', () => {
  it('parses ids, model and switches', () => {
    expect(parseArgs(['--ids', 'a, b,,c', '--model', 'anthropic.claude-sonnet-5', '--pairwise', '--dry-run'])).toEqual({
      ids: ['a', 'b', 'c'],
      model: 'anthropic.claude-sonnet-5',
      pairwise: true,
      dryRun: true,
    });
  });

  it('rejects an unknown flag, so a typo cannot turn a dry run into live judge calls', () => {
    expect(() => parseArgs(['--ids', 'a', '--dryrun'])).toThrow('unknown argument "--dryrun"');
    expect(() => parseArgs(['a', '--ids', 'b'])).toThrow('unknown argument "a"');
  });

  it('rejects a missing or flag-shaped operand instead of consuming the next flag', () => {
    expect(() => parseArgs(['--ids', '--dry-run'])).toThrow('--ids needs a value');
    expect(() => parseArgs(['--ids', 'a', '--model'])).toThrow('--model needs a value');
    expect(() => parseArgs(['--model', '--ids', 'a'])).toThrow('--model needs a value');
  });

  it('requires at least one id', () => {
    expect(() => parseArgs(['--dry-run'])).toThrow('--ids is required');
    expect(() => parseArgs(['--ids', ' , '])).toThrow('--ids is required');
  });
});

describe('scoreCreativeRubric priorBestFor', () => {
  const gates = evaluateCreativeGates(
    { bytes: 1000, decoded: true, width: 1080, height: 1350, luminanceStdDev: 40 },
    { requestedSize: '1080x1350' },
  );
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 1) + minute * 60_000).toISOString();
  const item = (candidateId: string, userId: string, minute: number): HumanEvalCandidate => ({
    candidateId,
    reviewType: 'creative_image',
    reviewer: 'matt',
    status: 'pending',
    userId,
    artifactUrl: `https://x/${candidateId}.png`,
    outputSummary: 'Image generated.',
    creativeGates: gates,
    feedback: [],
    createdAt: at(minute),
    updatedAt: at(minute),
  });

  it('finds an account\'s prior even when 250 newer creatives of other accounts precede it', async () => {
    const items: HumanEvalCandidate[] = [item('prior', 'user-1', 0)];
    for (let i = 0; i < 250; i++) items.push(item(`other-${i}`, 'user-2', 10 + i));
    const target = item('target', 'user-1', 1000);
    items.push(target);

    // Three scan pages, filtered as DynamoDB would apply the FilterExpression.
    const pages = [items.slice(0, 100), items.slice(100, 200), items.slice(200)];
    const scan = jest.fn((params: { ExclusiveStartKey?: { page: number }; ExpressionAttributeValues?: Record<string, string> }) => ({
      promise: async () => {
        const page = params.ExclusiveStartKey?.page ?? 0;
        const values = params.ExpressionAttributeValues;
        return {
          Items: values ? pages[page].filter((c) => c.userId === values[':userId'] && c.reviewType === values[':reviewType']) : pages[page],
          ...(page + 1 < pages.length ? { LastEvaluatedKey: { page: page + 1 } } : {}),
        };
      },
    }));
    const db = { put: jest.fn(), get: jest.fn(), update: jest.fn(), scan };
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);

    // The capped listing used before: the 200 newest creatives, none of them user-1's prior.
    const capped = await service.listCandidates({ reviewType: 'creative_image', limit: 200 });
    expect(capped.some((c) => c.candidateId === 'prior')).toBe(false);

    await expect(priorBestFor(target, service)).resolves.toMatchObject({ candidateId: 'prior' });
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({
      FilterExpression: 'userId = :userId AND reviewType = :reviewType',
      ExpressionAttributeValues: { ':userId': 'user-1', ':reviewType': 'creative_image' },
    }));
  });
});
