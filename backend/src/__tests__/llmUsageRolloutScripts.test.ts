import fs from 'fs';
import path from 'path';

describe('LLM usage rollout scripts', () => {
  it.each([
    'backfillScheduledChatModelBackups.ts',
    'resetLlmUsageForPolicyRollout.ts',
  ])('%s never performs an unrestricted DynamoDB scan', (filename) => {
    const source = fs.readFileSync(path.resolve(__dirname, '../scripts', filename), 'utf8');
    expect(source).not.toMatch(/\.scan\s*\(/);
    expect(source).toMatch(/--user-id|--billing-user-id/);
  });
});
