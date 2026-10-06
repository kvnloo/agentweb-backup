import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const externalPartnerUrl = process.env.E2E_PARTNER_URL?.trim();
const partnerUrl = externalPartnerUrl || 'http://127.0.0.1:5173';

export default {
  projectId: 'agentweb',
  tests: 'tests/**/*.e2e.ts',
  output: '.e2e',
  targets: [
    {
      name: 'partner-portal',
      platform: 'web',
      engine: web(),
      app: externalPartnerUrl
        ? { url: partnerUrl }
        : {
            url: partnerUrl,
            command: {
              executable: 'npm',
              args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '{port}'],
              cwd: '../partner-portal',
              reuseExisting: true,
            },
          },
    },
  ],
} satisfies E2EConfig;
