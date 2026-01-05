/**
 * Service to run generateMarketingResponse in a separate process
 * This prevents blocking the main event loop during long-running operations
 */

import { fork, ChildProcess } from 'child_process';
import path from 'path';

interface GenerateMarketingResponseParams {
  messageContent: string;
  sessionHistory: any[];
  userId: string;
  llmModel: string;
  sessionId: string;
  mockMode?: boolean;
}

interface GenerateMarketingResponseResult {
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
}

export class GenerateMarketingResponseWorkerService {
  /**
   * Run generateMarketingResponse in a separate process
   * This prevents blocking the main event loop, allowing health checks to continue working
   */
  async runInWorker(
    params: GenerateMarketingResponseParams,
    onProgress?: (progress: { iteration: number; status: string; toolCalls?: any[]; pendingTools?: string[] }) => void
  ): Promise<GenerateMarketingResponseResult> {
    return new Promise((resolve, reject) => {
      // Get the worker script path
      // In production/staging, __dirname points to dist/services, so we need to go up to dist/workers
      // In local development, we use ts-node to run the TypeScript file directly
      // Check if we're in a deployed environment by checking if __dirname contains 'dist'
      // (in deployed environments, code is in dist/, in local dev it's in src/)
      let workerScript: string;
      let execArgv: string[] = [];
      
      const isDeployedEnvironment = __dirname.includes('/dist/') || __dirname.includes('\\dist\\');
      const isLocalDevelopment = process.env.NODE_ENV === 'development' && !isDeployedEnvironment;
      
      if (isLocalDevelopment) {
        // Local development: use TypeScript with ts-node
        workerScript = path.join(__dirname, '../workers/generateMarketingResponseWorker.ts');
        execArgv = ['-r', 'ts-node/register'];
      } else {
        // Production/Staging/Deployed: use compiled JavaScript
        workerScript = path.join(__dirname, '../workers/generateMarketingResponseWorker.js');
      }
      
      // Fork a new process
      const worker: ChildProcess = fork(workerScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: process.env,
        execArgv: execArgv.length > 0 ? execArgv : undefined
      });

      // Forward stdout from worker to parent process
      if (worker.stdout) {
        worker.stdout.on('data', (data: Buffer) => {
          process.stdout.write(`[Worker] ${data}`);
        });
      }

      // Forward stderr from worker to parent process
      if (worker.stderr) {
        worker.stderr.on('data', (data: Buffer) => {
          process.stderr.write(`[Worker] ${data}`);
        });
      }

      // Set a timeout for the worker (45 minutes max)
      // Increased from 30 minutes to accommodate deep research operations
      // which can take up to 20 minutes (120 attempts * 10 seconds)
      const timeout = setTimeout(() => {
        worker.kill('SIGTERM');
        reject(new Error('generateMarketingResponse worker timed out after 45 minutes'));
      }, 45 * 60 * 1000);

      // Handle messages from worker
      worker.on('message', (message: any) => {
        if (message.type === 'progress') {
          // Forward progress updates to the callback
          if (onProgress) {
            onProgress(message.progress);
          }
          // Don't clear timeout on progress messages
          return;
        }
        
        clearTimeout(timeout);
        
        if (message.type === 'success') {
          worker.kill();
          resolve(message.result);
        } else if (message.type === 'error') {
          worker.kill();
          const error = new Error(message.error);
          if (message.stack) {
            error.stack = message.stack;
          }
          reject(error);
        }
      });

      // Handle worker errors
      worker.on('error', (error) => {
        clearTimeout(timeout);
        worker.kill();
        reject(error);
      });

      // Handle worker exit
      worker.on('exit', (code, signal) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          reject(new Error(`Worker process exited with code ${code} and signal ${signal}`));
        }
      });

      // Send the request to the worker
      worker.send({
        type: 'generateMarketingResponse',
        params
      });
    });
  }
}

export const generateMarketingResponseWorkerService = new GenerateMarketingResponseWorkerService();

