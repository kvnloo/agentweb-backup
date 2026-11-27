import { buildStdioChildEnv } from '../mcp/client/stdioChildEnv';

// Variable NAMES the production backend env held on 2026-11-25 that must never reach an MCP child.
const BACKEND_SECRETS = [
  'JWT_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'STRIPE_SECRET_KEY', 'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET', 'SLACK_VERIFICATION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'AZURE_OPENAI_API_KEY',
  'MCP_ACCESS_TOKEN', 'APOLLO_WEBHOOK_SECRET', 'FEATUREBASE_WEBHOOK_SECRET', 'LINEAR_WEBHOOK_SECRET',
  'UNIPILE_WEBHOOK_SECRET', 'PLACID_PRIVATE_TOKEN', 'GCS_CLIENT_EMAIL', 'META_SECRETS_NAME',
];

describe('buildStdioChildEnv (ENG-3187)', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin', HOME: '/home/webapp', LANG: 'en_US.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp',
    NODE_ENV: 'production', AWS_REGION: 'us-west-2',
    ...Object.fromEntries(BACKEND_SECRETS.map(k => [k, `secret-${k}`])),
  };

  it('passes no backend secret to the child', () => {
    const env = buildStdioChildEnv(parent, {});
    for (const k of BACKEND_SECRETS) expect(env).not.toHaveProperty(k);
    expect(Object.values(env).some(v => v.startsWith('secret-'))).toBe(false);
  });

  it('keeps PATH, HOME, locale and temp', () => {
    expect(buildStdioChildEnv(parent)).toEqual({
      PATH: '/usr/bin', HOME: '/home/webapp', LANG: 'en_US.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp',
    });
  });

  it("adds the server's own resolved env, which wins over the parent", () => {
    const env = buildStdioChildEnv(parent, { API_KEY: 'server-key', PATH: '/opt/bin' });
    expect(env.API_KEY).toBe('server-key');
    expect(env.PATH).toBe('/opt/bin');
  });
});
