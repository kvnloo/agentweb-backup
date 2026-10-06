import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const externalPartnerUrl = process.env.E2E_PARTNER_URL?.trim();

export default {
  projectId: 'agentweb-partner-portal',
  tests: 'tests/**/*.e2e.ts',
  output: '.e2e',
  targets: [
    {
      name: 'partner-portal',
      engine: web(),
      app: externalPartnerUrl
        ? { url: externalPartnerUrl }
        : {
            // Let e2e allocate a free loopback port so this lane can run beside
            // another AgentWeb checkout without fighting Vite's default :5173.
            url: 'http://127.0.0.1:0',
            command: {
              executable: 'npm',
              args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '{port}'],
              cwd: '../partner-portal',
              startupTimeout: 60_000,
              log: '.e2e/logs/partner-portal.log',
            },
          },
    },
  ],
} satisfies E2EConfig;
