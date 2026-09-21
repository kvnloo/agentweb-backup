import fs from 'fs';
import path from 'path';

const skillPath = path.join(__dirname, '../../docs/skill.md');
const skill = fs.readFileSync(skillPath, 'utf8');
const authentication = skill.slice(
  skill.indexOf('## Authentication'),
  skill.indexOf('## Tool Organization'),
);

describe('public MCP skill authentication guide', () => {
  it('keeps the public MCP endpoint documented', () => {
    expect(authentication).toContain('https://api.agentweb.pro/mcp');
  });

  it('links API-key users directly to the AgentWeb portal settings page', () => {
    expect(authentication).toContain('https://app.agentweb.pro/settings/api-keys');
    expect(authentication).not.toContain('https://start.agentweb.pro');
  });

  it('documents the complete headless registration and API-key response contract', () => {
    expect(authentication).toContain('POST https://api.agentweb.pro/api/auth/register');
    expect(authentication).toContain('POST https://api.agentweb.pro/api/v1/agent/api-keys');
    expect(authentication).toContain('"token": "JWT_TOKEN"');
    expect(authentication).toContain('"rawKey": "aw_YOUR_KEY"');
    expect(authentication).toContain('company email');
    expect(authentication).toContain('at least 12 characters');
    expect(authentication).toContain('Authorization: Bearer aw_YOUR_KEY');
  });

  it('distinguishes interactive OAuth from non-interactive API-key setup', () => {
    expect(authentication).toMatch(/interactive[\s\S]*OAuth/i);
    expect(authentication).toMatch(/headless[\s\S]*background[\s\S]*CI/i);
    expect(authentication).toMatch(/local OAuth callback/i);
  });
});
