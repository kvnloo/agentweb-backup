import { readFile } from 'fs/promises';
import { evaluationStore } from '../evaluationStore';
import { requireEvaluationAdmin, requireEvaluationReviewer } from '../evaluationPolicy';
import { importSandboxDataset } from './datasetImport';

export function parseDatasetPin(value: string): { datasetId: string; datasetVersion: number } {
  const match = /^([a-z0-9][a-z0-9-]{0,63})@([1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('Expected dataset-id@version');
  return { datasetId: match[1], datasetVersion: Number(match[2]) };
}

/** Credentials and provisioning passwords stay in a mode-0600 JSON input file, never argv. */
export async function runSandboxLifecycle(argv: string[]): Promise<unknown> {
  const [action, ...args] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i])) throw new Error('Expected unique --flag value pairs');
    flags.set(args[i], args[i + 1]);
  }
  const allowed: Record<string, string[]> = {
    provision: ['--actor', '--dataset', '--input'], reset: ['--actor', '--user'], purge: ['--actor', '--user'],
    revoke: ['--actor', '--user'], review: ['--actor', '--user', '--format'], 'load-dataset': ['--actor', '--directory'],
  };
  if (!allowed[action] || [...flags.keys()].some(key => !allowed[action].includes(key))) throw new Error('Unsupported sandbox command or flag');
  const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`Missing ${key}`); return value; };
  const actor = required('--actor');
  if (action === 'review') {
    const format = flags.get('--format') || 'json';
    if (!['json', 'markdown'].includes(format)) throw new Error('Expected --format json or markdown');
    await requireEvaluationReviewer(actor);
    const result = await evaluationStore.review(actor, required('--user'));
    await requireEvaluationReviewer(actor);
    return format === 'markdown' ? result.markdown : result;
  }
  if (!['development', 'production'].includes(process.env.NODE_ENV || '')) throw new Error('Set NODE_ENV explicitly to development or production for lifecycle writes');
  await requireEvaluationAdmin(actor);
  if (action === 'load-dataset') return importSandboxDataset(required('--directory'), actor);
  if (action === 'provision') {
    const pin = parseDatasetPin(required('--dataset'));
    const input = JSON.parse(await readFile(required('--input'), 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provision input must be a JSON object');
    return evaluationStore.provision(actor, { ...input, ...pin });
  }
  return evaluationStore[action as 'reset' | 'purge' | 'revoke'](actor, required('--user'));
}
