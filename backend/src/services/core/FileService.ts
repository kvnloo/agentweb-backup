
import axios from 'axios';
import crypto from 'crypto';

import { uploadFileToS3 } from '../../utils/s3Utils';
import { ToolService } from '../../tools/ServiceRegistry';

interface CachedFile {
  file_url: string;
  file_name: string;
  file_size: number;
}

interface PDFData {
  numpages: number;
  numrender: number;
  info: any;
  metadata: any;
  text: string;
  version: string;
}

export class FileService implements ToolService {
  readonly serviceName = 'file';
  
  // Cache for file content hash -> URL mapping to avoid duplicate uploads
  private fileContentCache = new Map<string, CachedFile>();

  /**
   * Save a file to S3
   */
  async saveFile(
    fileName: string, 
    fileContent: string, 
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('FileService: Saving file:', fileName, 'Size:', fileContent.length);

      // Simple deduplication - check if we just uploaded this content
      const contentHash = crypto.createHash('md5').update(fileContent).digest('hex');
      const cachedFile = this.fileContentCache.get(contentHash);

      if (cachedFile && cachedFile.file_name === fileName) {
        console.log('FileService: Returning cached file URL for hash:', contentHash);
        const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${cachedFile.file_url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;
        
        return {
          success: true,
          message: `File "${fileName}" has been saved successfully.`,
          file_url: cachedFile.file_url,
          file_name: fileName,
          file_size: fileContent.length,
          formattedContent
        };
      }

      // Determine content type based on file extension
      const extension = fileName.split('.').pop()?.toLowerCase();
      const contentTypes: { [key: string]: string } = {
        'txt': 'text/plain',
        'md': 'text/markdown',
        'json': 'application/json',
        'csv': 'text/csv',
        'html': 'text/html',
        'xml': 'application/xml',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      };
      const contentType = contentTypes[extension || ''] || 'application/octet-stream';

      // Upload to S3
      const uploadResult = await uploadFileToS3(
        fileContent,
        fileName,
        userId,
        contentType
      );

      if (uploadResult.success) {
        // Cache the file content hash to URL mapping
        this.fileContentCache.set(contentHash, {
          file_url: uploadResult.url || '',
          file_name: fileName || 'unknown',
          file_size: fileContent.length
        });

        console.log('FileService: File uploaded and cached with hash:', contentHash);

        // Format the save result for LLM consumption
        const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${uploadResult.url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;

        return {
          success: true,
          message: `File "${fileName}" has been saved successfully.`,
          file_url: uploadResult.url,
          file_name: fileName,
          file_size: fileContent.length,
          formattedContent
        };
      } else {
        return {
          success: false,
          message: 'Failed to save file to S3. Please try again.',
          error: uploadResult.error
        };
      }
    } catch (error) {
      console.error('FileService: Error saving file:', error);
      return {
        success: false,
        message: 'Failed to save file. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Read file content from URL with support for various file types
   */
  async readFileContent(fileUrl: string): Promise<any> {
    try {
      console.log('FileService: Reading file content from URL:', fileUrl);

      // Validate URL format
      if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
        return {
          success: false,
          message: 'Invalid URL format. Must be HTTP or HTTPS.',
          error: 'Invalid URL format'
        };
      }

      // Determine file type from URL
      const urlPath = new URL(fileUrl).pathname;
      const extension = urlPath.split('.').pop()?.toLowerCase() || '';

      // Fetch the file content
      const response = await axios.get(fileUrl, {
        timeout: 30000, // 30 seconds timeout for larger files
        responseType: 'arraybuffer', // Use arraybuffer to handle binary files
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });

      const buffer = Buffer.from(response.data as ArrayBuffer);
      const contentType = response.headers['content-type'] || '';

      console.log(`FileService: Successfully fetched file, size: ${buffer.length} bytes, type: ${contentType}`);

      // Process content based on file type
      let extractedContent = '';
      let fileType = 'unknown';

      if (extension === 'pdf' || contentType.includes('application/pdf')) {
        // Handle PDF files
        try {
          // Use dynamic require for pdf-parse if needed
          const pdfParse = require('pdf-parse');
          const pdfData: PDFData = await pdfParse(buffer);
          extractedContent = pdfData.text;
          fileType = 'pdf';
          console.log(`FileService: Successfully parsed PDF, extracted ${extractedContent.length} characters`);
        } catch (pdfError: any) {
          console.error('FileService: Error parsing PDF:', pdfError);
          return {
            success: false,
            message: 'Failed to parse PDF file.',
            error: pdfError.message
          };
        }
      } else if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'js', 'css', 'log', 'yml', 'yaml'].includes(extension)) {
        // Handle text-based files
        try {
          extractedContent = buffer.toString('utf-8');
          fileType = 'text';
          console.log(`FileService: Successfully read text file, extracted ${extractedContent.length} characters`);
        } catch (textError) {
          console.error('FileService: Error reading text file:', textError);
          return {
            success: false,
            message: 'Failed to read text file. The file may contain invalid characters.',
            error: textError instanceof Error ? textError.message : 'Text file reading failed'
          };
        }
      } else {
        // For other file types, try to read as text but with a warning
        try {
          extractedContent = buffer.toString('utf-8');
          fileType = 'text';
          console.log(`FileService: Attempted to read unknown file type as text, extracted ${extractedContent.length} characters`);
        } catch (textError) {
          console.error('FileService: Error reading file as text:', textError);
          return {
            success: false,
            message: 'Failed to read file as text.',
            error: textError instanceof Error ? textError.message : 'File reading failed'
          };
        }
      }

      // Format response for LLM
      const formattedContent = `📄 **File Content (${fileType.toUpperCase()})**\nSource: ${fileUrl}\nSize: ${extractedContent.length} characters\n\n\`\`\`${fileType === 'unknown' ? '' : fileType}\n${extractedContent.substring(0, 50000)}${extractedContent.length > 50000 ? '\n... (truncated)' : ''}\n\`\`\``;

      return {
        success: true,
        message: 'File content read successfully',
        content: extractedContent,
        file_type: fileType,
        source: fileUrl,
        formattedContent
      };

    } catch (error: any) {
      console.error('FileService: Error reading file content:', error);
      return {
        success: false,
        message: `Failed to read file from URL: ${fileUrl}`,
        error: error.message
      };
    }
  }
}

// Singleton instance
export const fileService = new FileService();
