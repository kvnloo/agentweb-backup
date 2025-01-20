import { spawn } from 'child_process';
import path from 'path';
import { taskDb } from './db';

interface WebAgentResult {
  success: boolean;
  output: string;
  error?: string;
}

export class WebAgent {
  private pythonPath: string;
  private scriptPath: string;
  private condaPath: string;
  private envName: string;

  constructor() {
    // Agent engine is now in the root directory
    this.condaPath = process.env.CONDA_PATH || 'conda';
    this.envName = 'agent-engine';
    this.pythonPath = 'python';
    this.scriptPath = path.join(__dirname, '../../../agent-engine/web_agent.py');
  }

  private async updateTaskStatus(taskId: string, status: string, output?: string) {
    const updates: any = { status };
    if (output) {
      updates.output = output;
    }
    await taskDb.updateTask(taskId, updates);
  }

  private getCondaCommand(): string[] {
    return [this.condaPath, 'run', '-n', this.envName, this.pythonPath];
  }

  async executeTask(taskId: string): Promise<WebAgentResult> {
    try {
      // Get task details from database
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      // Update task status to running
      await this.updateTaskStatus(taskId, 'running');

      return new Promise((resolve, reject) => {
        const pythonArgs = [
          this.scriptPath,
          '--task_id', taskId,
          '--prompt', task.prompt
        ];

        const pythonProcess = spawn(this.getCondaCommand()[0], [
          ...this.getCondaCommand().slice(1),
          ...pythonArgs
        ]);

        let outputData = '';
        let errorData = '';

        pythonProcess.stdout.on('data', (data) => {
          outputData += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          errorData += data.toString();
        });

        pythonProcess.on('close', async (code) => {
          if (code === 0) {
            await this.updateTaskStatus(taskId, 'completed', outputData);
            resolve({
              success: true,
              output: outputData
            });
          } else {
            await this.updateTaskStatus(taskId, 'failed', errorData);
            resolve({
              success: false,
              output: outputData,
              error: errorData
            });
          }
        });

        pythonProcess.on('error', async (error) => {
          await this.updateTaskStatus(taskId, 'failed', error.message);
          reject({
            success: false,
            output: '',
            error: error.message
          });
        });
      });
    } catch (error: any) {
      await this.updateTaskStatus(taskId, 'failed', error.message);
      return {
        success: false,
        output: '',
        error: error.message
      };
    }
  }
}

// Create a singleton instance
export const webAgent = new WebAgent(); 