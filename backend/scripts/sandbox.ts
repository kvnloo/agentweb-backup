/** See backend/docs/SANDBOX_DATASETS.md for compile/load/provision/review/reset/purge. */
import { runSandboxLifecycle } from '../src/services/sandbox/lifecycleCommand';

if (require.main === module) {
  runSandboxLifecycle(process.argv.slice(2)).then(result => {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }).catch(error => {
    // Do not print AWS request details, provisioning inputs or credentials on failure.
    console.error(`Sandbox command failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
