/**
 * Script to run benchmark tests against the backend API.
 *
 * Prerequisites:
 *   - Backend server must be running (npm run dev)
 *   - Admin credentials set in .env (ADMIN_EMAIL, ADMIN_PASSWORD)
 *     or passed via CLI flags
 *
 * Usage:
 *   npx ts-node src/scripts/run-benchmarks.ts [options]
 *
 * Options:
 *   --url <url>        Backend URL (default: http://localhost:3001)
 *   --email <email>    Admin email (default: ADMIN_EMAIL from .env)
 *   --password <pass>  Admin password (default: ADMIN_PASSWORD from .env)
 *   --test <testId>    Run a specific test by ID (can be repeated)
 *   --model <model>    Override LLM model for all runs
 *   --status <status>  Filter tests by status (default: active)
 *   --concurrency <n>  Max parallel test runs (default: 1)
 *   --dry-run          List tests without running them
 */

import dotenv from 'dotenv';
dotenv.config();

// ── Types ──────────────────────────────────────────────────────────────────────

interface BenchmarkTest {
  testId: string;
  testName: string;
  description?: string;
  status: 'draft' | 'active' | 'archived';
  llmModel?: string;
  runCount: number;
  successCount: number;
  failureCount: number;
  expectedOutput: {
    keywords?: string[];
    functionCalls?: string[];
  };
}

interface BenchmarkRunResult {
  testId: string;
  runId: string;
  status: 'success' | 'failure';
  passed: boolean;
  actualResponse: string;
  actualFunctionCalls: string[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  executionTime: number;
  errorMessage?: string;
  llmModel?: string;
}

// ── Argument parsing ───────────────────────────────────────────────────────────

function parseArgs(): {
  url: string;
  email: string;
  password: string;
  testIds: string[];
  model?: string;
  status: string;
  concurrency: number;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const opts: ReturnType<typeof parseArgs> = {
    url: process.env.BACKEND_URL || 'http://localhost:3001',
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
    testIds: [],
    model: undefined,
    status: 'active',
    concurrency: 1,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
        opts.url = args[++i];
        break;
      case '--email':
        opts.email = args[++i];
        break;
      case '--password':
        opts.password = args[++i];
        break;
      case '--test':
        opts.testIds.push(args[++i]);
        break;
      case '--model':
        opts.model = args[++i];
        break;
      case '--status':
        opts.status = args[++i];
        break;
      case '--concurrency':
        opts.concurrency = parseInt(args[++i], 10) || 1;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!opts.email || !opts.password) {
    console.error('Admin credentials required. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env or pass --email and --password.');
    process.exit(1);
  }

  return opts;
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.token;
}

async function fetchTests(baseUrl: string, token: string): Promise<BenchmarkTest[]> {
  const res = await fetch(`${baseUrl}/api/benchmark`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch tests (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.tests || data;
}

async function runTest(
  baseUrl: string,
  token: string,
  testId: string,
  model?: string
): Promise<{ message: string; result: BenchmarkRunResult }> {
  const body: Record<string, string> = {};
  if (model) body.llmName = model;

  const res = await fetch(`${baseUrl}/api/benchmark/${testId}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Run failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}

function printTestList(tests: BenchmarkTest[]): void {
  console.log('\n┌─────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ Benchmark Tests                                                                         │');
  console.log('├──────────────────────────────────┬──────────────────────────────┬────────┬───────────────┤');
  console.log('│ Test ID                          │ Name                         │ Status │ Pass Rate     │');
  console.log('├──────────────────────────────────┼──────────────────────────────┼────────┼───────────────┤');
  for (const t of tests) {
    const rate = t.runCount > 0 ? `${t.successCount}/${t.runCount} (${Math.round(t.successCount / t.runCount * 100)}%)` : 'no runs';
    console.log(
      `│ ${t.testId.padEnd(32)} │ ${truncate(t.testName, 28).padEnd(28)} │ ${t.status.padEnd(6)} │ ${rate.padEnd(13)} │`
    );
  }
  console.log('└──────────────────────────────────┴──────────────────────────────┴────────┴───────────────┘');
}

function printResult(test: BenchmarkTest, result: BenchmarkRunResult): void {
  const icon = result.passed ? '✅' : '❌';
  console.log(`\n${icon} ${test.testName} (${test.testId})`);
  console.log(`   Status: ${result.status} | Model: ${result.llmModel || 'default'} | Duration: ${formatDuration(result.executionTime)}`);

  if (result.keywordMatches.length > 0) {
    console.log(`   Keywords matched: ${result.keywordMatches.join(', ')}`);
  }
  if (result.keywordMisses.length > 0) {
    console.log(`   Keywords missed:  ${result.keywordMisses.join(', ')}`);
  }
  if (result.functionCallMatches.length > 0) {
    console.log(`   Tools matched:    ${result.functionCallMatches.join(', ')}`);
  }
  if (result.functionCallMisses.length > 0) {
    console.log(`   Tools missed:     ${result.functionCallMisses.join(', ')}`);
  }
  if (result.errorMessage) {
    console.log(`   Error: ${result.errorMessage}`);
  }
  if (result.actualFunctionCalls.length > 0) {
    console.log(`   All tools called: ${result.actualFunctionCalls.join(', ')}`);
  }
}

function printSummary(results: { test: BenchmarkTest; result: BenchmarkRunResult }[]): void {
  const total = results.length;
  const passed = results.filter(r => r.result.passed).length;
  const failed = total - passed;
  const totalTime = results.reduce((sum, r) => sum + r.result.executionTime, 0);

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`  Summary: ${passed} passed, ${failed} failed, ${total} total`);
  console.log(`  Total execution time: ${formatDuration(totalTime)}`);
  console.log('════════════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const { test, result } of results.filter(r => !r.result.passed)) {
      console.log(`  - ${test.testName}: ${result.errorMessage || 'criteria not met'}`);
    }
  }
}

// ── Concurrent execution helper ────────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`Connecting to ${opts.url}...`);

  // Authenticate
  const token = await login(opts.url, opts.email, opts.password);
  console.log('Authenticated successfully.');

  // Fetch tests
  let tests = await fetchTests(opts.url, token);
  console.log(`Found ${tests.length} benchmark tests total.`);

  // Filter by status
  tests = tests.filter(t => t.status === opts.status);
  console.log(`${tests.length} tests with status "${opts.status}".`);

  // Filter by specific IDs if provided
  if (opts.testIds.length > 0) {
    const idSet = new Set(opts.testIds);
    tests = tests.filter(t => idSet.has(t.testId));
    console.log(`${tests.length} tests matched the provided IDs.`);
  }

  if (tests.length === 0) {
    console.log('No tests to run.');
    process.exit(0);
  }

  printTestList(tests);

  if (opts.dryRun) {
    console.log('\n--dry-run: skipping execution.');
    process.exit(0);
  }

  // Run tests
  console.log(`\nRunning ${tests.length} test(s) (concurrency: ${opts.concurrency})${opts.model ? ` with model override: ${opts.model}` : ''}...\n`);

  const completedResults: { test: BenchmarkTest; result: BenchmarkRunResult }[] = [];

  await runWithConcurrency(tests, opts.concurrency, async (test, index) => {
    console.log(`[${index + 1}/${tests.length}] Running: ${test.testName}...`);

    try {
      const response = await runTest(opts.url, token, test.testId, opts.model);
      completedResults.push({ test, result: response.result });
      printResult(test, response.result);
    } catch (error) {
      const errorResult: BenchmarkRunResult = {
        testId: test.testId,
        runId: 'error',
        status: 'failure',
        passed: false,
        actualResponse: '',
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: test.expectedOutput.keywords || [],
        functionCallMatches: [],
        functionCallMisses: test.expectedOutput.functionCalls || [],
        executionTime: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      completedResults.push({ test, result: errorResult });
      printResult(test, errorResult);
    }
  });

  printSummary(completedResults);

  const allPassed = completedResults.every(r => r.result.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
