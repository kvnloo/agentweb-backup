/**
 * DEPRECATED (2026-07, ENG-383): local agent relay tool stubs.
 *
 * The local agent relay (ngrok tunnel to a Codex agent on a user's Mac) is
 * permanently dead — the ngrok account was suspended (ERR_NGROK_6008) and the
 * host machine is gone (ENG-381/ENG-383). The relay client, Secrets Manager
 * config fetch, task-scope validator, crash/timeout classification, and S3
 * screenshot upload that used to live here were all deleted with it.
 *
 * Both tools stay REGISTERED so that legacy skills, scheduled chats, and
 * forced tool calls that still reference them fail fast with a clear,
 * actionable deprecation error instead of an opaque "tool not found".
 * The handlers return immediately: no network, no Secrets Manager, no S3.
 *
 * Replacement: you_search_web / you_search_news for web research; remaining
 * local-agent workloads are being replaced under ENG-381.
 */
import { emmaToolRegistry } from './registry';

export const LOCAL_AGENT_DEPRECATION_ERROR =
  'local_agent_deprecated: The local agent relay was retired in July 2026. ' +
  'For web research use you_search_web / you_search_news; other local-agent ' +
  'workloads are being replaced (see ENG-381).';

function deprecatedResult(): { success: false; error: string } {
  return { success: false, error: LOCAL_AGENT_DEPRECATION_ERROR };
}

emmaToolRegistry.register({
  name: 'run_local_agent_task',
  definition: {
    name: 'run_local_agent_task',
    description:
      'DEPRECATED (2026-07): The local agent relay was retired and this tool always fails. ' +
      'Do not call it. For web research use you_search_web or you_search_news instead.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Ignored — the local agent relay was retired in July 2026.',
        },
      },
      required: [],
    },
  },
  execute: async () => deprecatedResult(),
});

emmaToolRegistry.register({
  name: 'check_local_agent_status',
  definition: {
    name: 'check_local_agent_status',
    description:
      'DEPRECATED (2026-07): The local agent relay was retired and this tool always fails. ' +
      'Do not call it. For web research use you_search_web or you_search_news instead.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async () => deprecatedResult(),
});
