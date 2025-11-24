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
    params: GenerateMarketingResponseParams
  ): Promise<GenerateMarketingResponseResult> {
    return new Promise((resolve, reject) => {
      // Get the worker script path
      // In production, __dirname points to dist/services, so we need to go up to dist/workers
      // In development, we use ts-node to run the TypeScript file directly
      let workerScript: string;
      let execArgv: string[] = [];
      
      if (process.env.NODE_ENV === 'production') {
        // Production: use compiled JavaScript
        workerScript = path.join(__dirname, '../workers/generateMarketingResponseWorker.js');
      } else {
        // Development: use TypeScript with ts-node
        workerScript = path.join(__dirname, '../workers/generateMarketingResponseWorker.ts');
        execArgv = ['-r', 'ts-node/register'];
      }
      
      // Fork a new process
      const worker: ChildProcess = fork(workerScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: process.env,
        execArgv: execArgv.length > 0 ? execArgv : undefined
      });

      // Set a timeout for the worker (30 minutes max)
      const timeout = setTimeout(() => {
        worker.kill('SIGTERM');
        reject(new Error('generateMarketingResponse worker timed out after 30 minutes'));
      }, 30 * 60 * 1000);

      // Handle messages from worker
      worker.on('message', (message: any) => {
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

