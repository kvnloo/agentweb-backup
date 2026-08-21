import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, 'e2e/usage-runway.e2e.test.ts'),
  'utf8',
);

describe('usage-runway E2E fixture contract', () => {
  it('keeps the existing production-target refusal', () => {
    expect(source).toContain('function assertNotProduction(): void');
    expect(source).toContain("PREFIX === ''");
  });

  it('runs every scenario as a unique ephemeral user', () => {
    expect(source).toContain('const FIXTURE_EMAIL =');
    expect(source).toContain('Key: { email: FIXTURE_EMAIL }');
  });

  it('creates the fixture without overwriting an existing account', () => {
    expect(source).toContain("ConditionExpression: 'attribute_not_exists(email)'");
  });

  it('deletes the ephemeral user during teardown', () => {
    expect(source).toMatch(
      /if \(fixtureCreated\) \{[\s\S]*delete\(\{ TableName: USERS_TABLE, Key: \{ email: FIXTURE_EMAIL \} \}\)/,
    );
    expect(source).toContain(
      'delete({ TableName: USERS_TABLE, Key: { email: FIXTURE_EMAIL } })',
    );
  });
});
