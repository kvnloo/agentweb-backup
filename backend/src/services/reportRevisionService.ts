import AWS from 'aws-sdk';
import { taskDb } from './db';
import { getAzureClient } from '../utils/llmClients';
import { meterUserUsage } from './usageRecorderService';
import axios from 'axios';
import { settingsService } from './settingsService';

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';

export class ReportRevisionService {
  private s3: AWS.S3;

  constructor() {
    this.s3 = new AWS.S3({
      region: process.env.AWS_REGION || 'us-west-2',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    });
  }

  /**
   * Metered Azure client for report revision. Preserves the original bespoke
   * deployment + api-version (AGENT_MODE env vars) so usage is recorded without
   * changing which endpoint/version the calls hit.
   */
  private client(userId?: string) {
    return getAzureClient(
      { userId, feature: 'report_revision' },
      process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
      { apiVersion: process.env.AZURE_OPENAI_API_VERSION_AGENT_MODE || '2025-01-01-preview' }
    );
  }

  /**
   * Create a revision of an HTML report using backend AI
   */
  async createReportRevision(
    taskId: string,
    executionId: string,
    originalReportUrl: string,
    revisionPrompt: string,
    userId: string,
    originalExecutionId?: string
  ): Promise<{ success: boolean; resultFile?: any; error?: string }> {
    try {
      console.log(`Creating report revision for task ${taskId}, execution ${executionId}`);

      // Execution is already set to 'running' status, no need to update

      // Download the original report
      const originalReport = await this.fetchContentFromUrl(originalReportUrl);
      if (!originalReport) {
        throw new Error('Failed to download original report');
      }

      // Get the original execution to find image files for context
      let enhancedRevisionPrompt = revisionPrompt;
      
      if (originalExecutionId) {
        const { taskDb } = await import('./db');
        const originalExecution = await taskDb.getTaskExecutionById(originalExecutionId);
        
        if (originalExecution && originalExecution.result_files) {
          const imageFiles = originalExecution.result_files.filter((file: any) => file.file_type === 'image');
          console.log(`📸 Found ${imageFiles.length} image files in original execution ${originalExecutionId}`);
          
          if (imageFiles.length > 0) {
            const imageContext = imageFiles.map((file: any) => 
              `- ${file.filename || 'unnamed'}: ${file.url}`
            ).join('\n');
            
            enhancedRevisionPrompt = `${revisionPrompt}\n\nAvailable image files that you can reference:\n${imageContext}`;
            console.log(`📸 Added ${imageFiles.length} image files as context to revision prompt`);
          } else {
            console.log(`📸 No image files found in original execution ${originalExecutionId}`);
          }
        } else {
          console.log(`📸 No result files found in original execution ${originalExecutionId}`);
        }
      } else {
        console.log(`📸 No original execution ID provided, skipping image context`);
      }

      // Generate the revised report using AI
      const { revisedContent, resultFile } = await this.generateRevisedReport(
        originalReport,
        enhancedRevisionPrompt,
        taskId,
        executionId,
        userId
      );

      // Update execution with completion status and result files (using direct DynamoDB update)
      await this.updateExecutionDirect(executionId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        result_files: [resultFile]
      });

      // Check if approval is required and send Slack approval request
      await this.handleApprovalIfRequired(taskId, executionId, resultFile, userId);

      console.log(`Report revision completed successfully for execution ${executionId}`);
      return { success: true, resultFile };

    } catch (error) {
      console.error('Error creating report revision:', error);
      
      // Update execution status to failed (using direct DynamoDB update)
      await this.updateExecutionDirect(executionId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Update task execution using direct DynamoDB update (following agent-engine pattern)
   */
  private async updateExecutionDirect(executionId: string, updates: any): Promise<void> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-TaskExecutions`,
        Key: { executionId },
        UpdateExpression: `SET ${Object.keys(updates).map(key => `#${key} = :${key}`).join(', ')}`,
        ExpressionAttributeNames: Object.keys(updates).reduce((acc, key) => ({ ...acc, [`#${key}`]: key }), {}),
        ExpressionAttributeValues: Object.entries(updates).reduce((acc, [key, value]) => ({ ...acc, [`:${key}`]: value }), {}),
        ReturnValues: "ALL_NEW"
      };

      await dynamodb.update(params).promise();
      console.log(`✅ Updated execution ${executionId} with:`, Object.keys(updates));
    } catch (error) {
      console.error(`❌ Error updating execution ${executionId}:`, error);
      throw error;
    }
  }


  /**
   * Handle approval request if required
   */
  private async handleApprovalIfRequired(
    taskId: string, 
    executionId: string, 
    resultFile: any, 
    userId: string
  ): Promise<void> {
    try {
      // Get the execution record to check if approval is required
      const execution = await taskDb.getTaskExecutionById(executionId);
      if (!execution) {
        console.log(`Execution ${executionId} not found, skipping approval check`);
        return;
      }

      // Check if approval is required
      const requiresApproval = execution.requireApproval;
      const slackChannel = execution.slack_channel;
      
      if (!requiresApproval || !slackChannel) {
        console.log(`No approval required for execution ${executionId} (requireApproval: ${requiresApproval}, slackChannel: ${slackChannel})`);
        return;
      }

      console.log(`Sending approval request for execution ${executionId} to channel ${slackChannel}`);

      // Import the Slack service
      const { sendApprovalRequestWithTracking } = await import('./slackService');

      // Ensure filename has .html extension for proper asset type detection
      const filename = resultFile.filename.endsWith('.html') ? resultFile.filename : `${resultFile.filename}.html`;

      // Send approval request with database tracking
      // Use the task owner's user ID (from execution.userId) instead of the revision initiator
      await sendApprovalRequestWithTracking({
        executionId,
        imageUrl: resultFile.url,
        filename: filename,
        assetType: 'html', // Report revisions are always HTML
        userId: execution.userId, // Use task owner's user ID, not the revision initiator
        channel: slackChannel,
        note: `A revised HTML report has been generated. Please review and approve. Once approved, results will be automatically sent to all task subscribers.`
      });

      console.log(`Approval request sent successfully for execution ${executionId}`);
    } catch (error) {
      console.error(`Error sending approval request for execution ${executionId}:`, error);
      // Don't throw error - approval failure shouldn't break the revision process
    }
  }

  /**
   * Fetch content from URL using axios (similar to filesController.getFileContent)
   */
  private async fetchContentFromUrl(url: string): Promise<string | null> {
    try {
      console.log(`🔽 Fetching content from URL: ${url}`);

      const response = await axios.get(url, {
        timeout: 15000, // 15 seconds timeout
        responseType: 'text',
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });

      const content = response.data as string;
      console.log(`✅ Successfully fetched content, length: ${content.length}`);

      return content;
    } catch (error: any) {
      console.error(`❌ Error fetching content from URL: ${url}`, error.message);
      return null;
    }
  }

  /**
   * Function to handle write_revised_report call
   */
  private async handleWriteRevisedReport(
    revisedContent: string,
    filename: string,
    taskId: string,
    executionId: string
  ): Promise<any> {
    return await this.uploadRevisedReport(taskId, executionId, revisedContent, filename);
  }

  /**
   * Get the configurable system instruction for report revision
   */
  private async getReportRevisionSystemInstruction(): Promise<string> {
    try {
      const setting = await settingsService.getSetting('report_revision_system_instruction');
      if (setting && setting.settingValue) {
        return setting.settingValue;
      }
    } catch (error) {
      console.error('Error getting custom report revision system instruction:', error);
    }
    
    // Fallback to default system instruction
    return `You are an expert web developer and content editor. You will be given an HTML report and revision instructions. 
Your task is to revise the report according to the instructions, which may include content changes, style modifications, or both.

Guidelines:
- Follow the revision instructions exactly - they may ask for content changes, style changes, etc.
- Maintain professional formatting and readability
- Preserve data tables, charts, and structured content unless specifically asked to modify them
- Keep the overall HTML structure intact unless specifically asked to change it
- If adding new styles, use appropriate CSS classes or inline styles
- Ensure any new styles are consistent with the existing design

You MUST use the write_revised_report function to provide the complete revised HTML report with a filename.`;
  }

  /**
   * Generate revised report using AI with function calls
   */
  private async generateRevisedReport(
    originalReport: string,
    revisionPrompt: string,
    taskId: string,
    executionId: string,
    userId?: string
  ): Promise<{ revisedContent: string; resultFile: any }> {
    const systemPrompt = await this.getReportRevisionSystemInstruction();

    const userPrompt = `Please revise the HTML report according to these instructions: ${revisionPrompt}

    Original HTML Report:
    \`\`\`html
    ${originalReport}
    \`\`\`

    You MUST use the write_revised_report function to provide the complete revised HTML report with a filename.`;

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'write_revised_report',
          description: 'Write the revised HTML report content and upload it',
          parameters: {
            type: 'object',
            properties: {
              revised_content: {
                type: 'string',
                description: 'The complete revised HTML report content'
              },
              filename: {
                type: 'string',
                description: 'The filename for the revised report (e.g., <topic>_revised_report.html)'
              }
            },
            required: ['revised_content', 'filename']
          }
        }
      }
    ];

    // Build messages array for conversation
    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Retry up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Attempt ${attempt} to generate revised report...`);

        const response = await this.client(userId).chat.completions.create({
          model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
          messages,
          tools,
          tool_choice: 'required', // Force the AI to use the function
          temperature: 0.7
        });

        meterUserUsage({
          userId,
          model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
          provider: 'azure',
          feature: 'report_revision',
          inputTokens: (response as any)?.usage?.prompt_tokens || 0,
          outputTokens: (response as any)?.usage?.completion_tokens || 0,
        });

        const responseMessage = response.choices[0].message;
        
        // Handle function calls
        if (responseMessage.tool_calls) {
          for (const toolCall of responseMessage.tool_calls) {
            if (toolCall.function.name === 'write_revised_report') {
              const args = JSON.parse(toolCall.function.arguments);
              const revisedContent = args.revised_content;
              const filename = args.filename;
              
              if (!revisedContent || !filename) {
                throw new Error('No revised content or filename generated by AI');
              }

              // Upload the revised report to S3 and get the result file
              const resultFile = await this.handleWriteRevisedReport(
                revisedContent,
                filename,
                taskId,
                executionId
              );

              console.log(`Successfully generated revised report on attempt ${attempt}`);
              return { revisedContent, resultFile };
            }
          }
        }

        // If we get here, the AI didn't call the function properly
        // Add the AI's response and retry message to the conversation
        messages.push(responseMessage as any);
        messages.push({
          role: 'user',
          content: 'Please try again. You MUST call the write_revised_report function with both revised_content and filename parameters.'
        });

      } catch (error) {
        console.error(`Attempt ${attempt} failed:`, error);
        
        if (attempt === 3) {
          // Last attempt failed, throw the error
          throw new Error(`Failed to generate revised report after 3 attempts. Last error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    // This should never be reached due to the throw in the loop, but TypeScript needs it
    throw new Error('Unexpected error in retry loop');
  }

  /**
   * Update an existing report by replacing its content (for repair image embedding)
   */
  async updateReport(
    reportUrl: string,
    executionId: string,
    revisionPrompt: string,
    taskId: string
  ): Promise<{ success: boolean; resultFile?: any; error?: string }> {
    try {
      console.log(`Updating report for execution ${executionId}`);

      // Get the current execution to get context about other files
      const { taskDb } = await import('./db');
      const execution = await taskDb.getTaskExecutionById(executionId);
      if (!execution) {
        throw new Error('Execution not found');
      }

      // Download the original report
      const originalReport = await this.fetchContentFromUrl(reportUrl);
      if (!originalReport) {
        throw new Error('Failed to download original report');
      }

      // Add context about other files in result_files to the revision prompt
      const resultFiles = execution.result_files || [];
      const otherFiles = resultFiles.filter((file: any) => file.url !== reportUrl);
      
      let enhancedRevisionPrompt = revisionPrompt;
      if (otherFiles.length > 0) {
        const fileContext = otherFiles.map((file: any) => 
          `- ${file.filename || 'unnamed'}: ${file.url}`
        ).join('\n');
        
        enhancedRevisionPrompt = `${revisionPrompt}\n\nAvailable files that you can reference:\n${fileContext}`;
      }

      // Generate the updated report using AI
      const { revisedContent, resultFile } = await this.generateRevisedReport(
        originalReport, 
        enhancedRevisionPrompt, 
        taskId,
        executionId
      );

      // Update the result_files array, replacing the old report with the new one
      const updatedResultFiles = resultFiles.map((file: any) => {
        if (file.url === reportUrl) {
          return resultFile;
        }
        return file;
      });

      // Update the execution with the merged result_files
      await this.updateExecutionDirect(executionId, {
        result_files: updatedResultFiles
      });

      console.log(`Report update completed successfully for execution ${executionId}`);
      return { success: true, resultFile };

    } catch (error) {
      console.error('Error updating report:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }


  /**
   * Upload the revised report to S3
   */
  private async uploadRevisedReport(
    taskId: string,
    executionId: string,
    revisedContent: string,
    filename: string
  ): Promise<any> {
    try {
      // Generate a random token for the S3 path
      const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const s3Key = `tasks/${taskId}/executions/${executionId}/revisions/${randomToken}/${filename}`;

      // Upload to S3 (matching agent-engine format)
      await this.s3.putObject({
        Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
        Key: s3Key,
        Body: revisedContent,
        ContentType: 'text/html; charset=utf-8',
        ContentDisposition: `inline; filename="${filename}"`
      }).promise();

      // Generate the public URL
      const url = `https://${process.env.AWS_S3_BUCKET || 'agentweb-user-files'}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${s3Key}`;

      // Return result file object (matching agent-engine format)
      return {
        url,
        filename,
        token: randomToken,
        is_html: true,
        view_type: 'html',
        revision_info: {
          original_execution_id: executionId,
          revised_at: new Date().toISOString(),
          revision_type: 'backend_ai'
        }
      };

    } catch (error) {
      console.error('Error uploading revised report:', error);
      throw error;
    }
  }
}

export const reportRevisionService = new ReportRevisionService();
