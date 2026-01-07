
import { searchPlatformKnowledgeBase } from '../chatbotService';
import { taskDb } from '../db';
import { getGCSPPrivateKey } from '../../utils/secretsManager';
import { Storage } from '@google-cloud/storage';
import { ToolService } from '../../tools/ServiceRegistry';

/**
 * Knowledge base file entry
 */
export interface KnowledgeBaseFile {
  kbIdentifier: string;
  fileName: string;
  fileType?: string;
  createdAt?: string;
}

/**
 * Knowledge base search result
 */
export interface KnowledgeBaseSearchResult {
  content: string;
  source?: string;
  score?: number;
  metadata?: Record<string, any>;
}

/**
 * Knowledge Base Service
 */
export class KnowledgeBaseService implements ToolService {
  readonly serviceName = 'knowledge_base';

  /**
   * Search the knowledge base
   */
  async searchKnowledgeBase(
    query: string,
    maxResults: number = 5,
    userId: string
  ): Promise<{
    success: boolean;
    results?: any[];
    message?: string;
    error?: string;
    query?: string;
    totalResults?: number;
  }> {
    try {
      console.log('KnowledgeBaseService: Searching knowledge base for query:', query, 'maxResults:', maxResults);
      
      const limitedMaxResults = Math.min(maxResults || 5, 10);
      const results = await searchPlatformKnowledgeBase(query, limitedMaxResults, userId);
      
      if (!results || results.length === 0) {
        return {
          success: true,
          message: `No knowledge base results found for "${query}"`,
          query,
          results: [],
          totalResults: 0
        };
      }
      
      return {
        success: true,
        message: `Found ${results.length} knowledge base results for "${query}"`,
        query,
        results: results.map((result:any) => ({
          content: result.content,
          source: result.metadata?.source || 'unknown'
        })),
        totalResults: results.length
      };
    } catch (error: any) {
      console.error('KnowledgeBaseService: Error searching:', error);
      return {
        success: false,
        error: error.message,
        message: 'Knowledge base search failed'
      };
    }
  }

  /**
   * List files in the knowledge base
   */
  async listKnowledgeBaseFiles(userId: string): Promise<any> {
    try {
      console.log('KnowledgeBaseService: Listing knowledge base files for user:', userId);

      // Use the common function to get tasks with knowledge base
      const knowledgeBaseTasks = await taskDb.getTasksWithKnowledgeBase(userId);

      if (!knowledgeBaseTasks || knowledgeBaseTasks.length === 0) {
        return {
          success: true,
          message: 'No knowledge bases found',
          knowledge_bases: [],
          totalKnowledgeBases: 0,
          totalFiles: 0
        };
      }

      const knowledgeBases = knowledgeBaseTasks.map((task: any) => {
        const taskId = task.taskId;
        const taskName = task.name;
        const kbType = task.knowledgeBaseType || 'private';
        const kbUpdatedAt = task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt;
        // Default file + uploaded files
        const files = [
          {
            fileName: 'knowledge-base.txt',
            fileSize: task.knowledgeBaseSize || 0,
            url: task.knowledgeBase || null
          },
          ...(task.knowledgeBaseFiles || []).map((f: any) => ({
            fileName: f.filename,
            fileSize: f.size || 0,
            url: f.url || null
          }))
        ];

        return {
          identifier: taskId,
          name: taskName,
          type: kbType,
          updatedAt: kbUpdatedAt,
          files
        };
      });

      const totalFiles = knowledgeBases.reduce(
        (sum: number, kb: any) => sum + (kb.files?.length || 0),
        0
      );

      return {
        success: true,
        message: `Found ${knowledgeBases.length} knowledge base(s) with ${totalFiles} file(s). Ensure to use the complete file URL to access the file.`,
        knowledge_bases: knowledgeBases,
        totalKnowledgeBases: knowledgeBases.length,
        totalFiles
      };
    } catch (error: any) {
      console.error('KnowledgeBaseService: Error listing files:', error);
      return {
        success: false,
        message: 'Failed to list knowledge base files',
        error: error.message
      };
    }
  }

  /**
   * Read multiple knowledge base files
   */
  async readKnowledgeBaseFiles(files: Array<{ kb_identifier: string; file_name: string }>, userId: string): Promise<any> {
    try {
      if (!Array.isArray(files) || files.length === 0) {
        return {
          success: false,
          message: 'files array is required'
        };
      }

      const results: any[] = [];

      for (const entry of files) {
        const kbIdentifier = entry?.kb_identifier;
        const fileName = entry?.file_name;

        if (!kbIdentifier || !fileName) {
          results.push({
            success: false,
            message: 'kb_identifier and file_name are required'
          });
          continue;
        }

        try {
          const result = await this.readSingleKnowledgeBaseFile(kbIdentifier, fileName, userId);
          results.push(result);
        } catch (err: any) {
          results.push({
            success: false,
            message: `Failed to read knowledge base file: ${err?.message || 'Unknown error'}`
          });
        }
      }

      return {
        success: true,
        message: `Read ${results.filter(r => r.success).length} of ${results.length} file(s)`,
        files: results
      };
    } catch (error: any) {
      console.error('KnowledgeBaseService: Error reading files:', error);
      return {
        success: false,
        message: 'Failed to read knowledge base files',
        error: error.message
      };
    }
  }

  /**
   * Read a specific file from the knowledge base
   */
  async readKnowledgeBaseFile(
    fileIdentifier: string | { kb_identifier: string; file_name: string },
    userId: string
  ): Promise<any> {
    let kbIdentifier: string | undefined;
    let fileName: string | undefined;

    if (typeof fileIdentifier === 'string') {
      if (fileIdentifier.includes('::')) {
        const [kb, file] = fileIdentifier.split('::');
        kbIdentifier = kb;
        fileName = file;
      } else if (fileIdentifier.includes('/')) {
        const [kb, ...rest] = fileIdentifier.split('/');
        kbIdentifier = kb;
        fileName = rest.join('/');
      }
    } else if ((fileIdentifier as any)?.kb_identifier && (fileIdentifier as any)?.file_name) {
      kbIdentifier = (fileIdentifier as any).kb_identifier;
      fileName = (fileIdentifier as any).file_name;
    }

    if (!kbIdentifier || !fileName) {
      return {
        success: false,
        message: 'file_identifier must include kb_identifier and file_name'
      };
    }

    return await this.readSingleKnowledgeBaseFile(kbIdentifier, fileName, userId);
  }

  /**
   * Helper: Read single file
   */
  private async readSingleKnowledgeBaseFile(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
    // Get the task
    const task = await taskDb.getTaskById(kbIdentifier);
    if (!task) {
      return { success: false, message: `Knowledge base "${kbIdentifier}" not found` };
    }

    // Auth check
    if (task.userId !== userId) {
      return { success: false, message: 'Not authorized to access this knowledge base file' };
    }

    // Default file size check
    const size = typeof task.knowledgeBaseSize === 'string'
      ? parseInt(task.knowledgeBaseSize)
      : task.knowledgeBaseSize || 0;
    
    if (fileName === 'knowledge-base.txt' && size === 0) {
      return { success: false, message: `Knowledge base file "${fileName}" is empty or does not exist` };
    }

    // Storage setup
    const privateKey = await getGCSPPrivateKey();
    const storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: { client_email: process.env.GCS_CLIENT_EMAIL, private_key: privateKey }
    });
    const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev';
    const PRIVATE_BUCKET_NAME = process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev';
    const bucketType = task.knowledgeBaseType || 'private';
    const bucket = storage.bucket(bucketType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);

    // Resolve path
    let filePath: string;
    if (fileName === 'knowledge-base.txt') {
      filePath = `tasks/${kbIdentifier}/knowledge-base.txt`;
    } else {
      const kbFiles = (task as any).knowledgeBaseFiles || [];
      const matched = kbFiles.find((f: any) => f.filename === fileName || f.key?.endsWith(fileName));
      if (!matched) {
        return { success: false, message: `Knowledge base file "${fileName}" not found in metadata` };
      }
      filePath = matched.key || `tasks/${kbIdentifier}/knowledge-base-files/${fileName}`;
    }

    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) {
      return { success: false, message: `Knowledge base file "${fileName}" not found in storage` };
    }

    // Download content
    const [content] = await file.download();
    
    // Convert to string
    const contentString = content.toString('utf-8');
    
    return {
      success: true,
      content: contentString,
      file_name: fileName,
      kb_identifier: kbIdentifier,
      file_size: contentString.length,
      message: `Successfully read file "${fileName}"`
    };
  }
}

// Singleton instance
export const knowledgeBaseService = new KnowledgeBaseService();
