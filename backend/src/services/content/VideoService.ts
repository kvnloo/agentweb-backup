
import { ToolService } from '../../tools/ServiceRegistry';
import { getSecret } from '../../utils/secretsManager';
import { chatbotDb } from '../chatbotService';
import path from 'path';
import os from 'os';
import { createWriteStream, promises as fs } from 'fs';
import axios from 'axios';
import { Readable } from 'stream';

/**
 * Video Service
 * Manages video creation and analysis.
 */

export class VideoService implements ToolService {
  readonly serviceName = 'video';

  /**
   * Generate a video using AI video generation models
   */
  async generateVideo(
    prompt: string,
    filename: string,
    userId: string,
    sessionId: string,
    videoModel?: string,
    startFrame?: string,
    endFrame?: string
  ): Promise<any> {
    try {
      console.log('VideoService: Generating video with prompt:', prompt, 'filename:', filename, 'videoModel:', videoModel, 'startFrame:', startFrame ? 'provided' : 'none', 'endFrame:', endFrame ? 'provided' : 'none', 'userId:', userId, 'sessionId:', sessionId);

      // Import the video generation service
      const { videoService } = await import('../videoGeneration');

      // Check if the service is available
      const isAvailable = await videoService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Video generation service is not available. Please check API key configuration in AWS Secrets Manager.',
          error: 'Service unavailable'
        };
      }

      // Generate the video
      const result = await videoService.generateVideo({
        prompt,
        filename,
        userId,
        videoModel,
        startFrame,
        endFrame
      });

      if (result.success && result.videoUrl) {
        // Save the video URL to the session for reference
        const videoData = {
          url: result.videoUrl,
          filename: result.filename,
          generatedAt: new Date().toISOString(),
          prompt: prompt,
          model: videoModel || 'veo-3.1-generate-preview'
        };

        // Store video data in session metadata (optional)
        try {
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Video generated: ${result.filename}`,
            metadata: {
              timestamp: new Date().toISOString()
            }
          });
        } catch (error) {
          console.warn('Failed to store video generation metadata:', error);
        }

        return {
          success: true,
          message: `✅ Video "${result.filename}" generated successfully!`,
          videoUrl: result.videoUrl,
          filename: result.filename,
          prompt: prompt,
          model: videoModel || 'veo-3.1-generate-preview'
        };
      } else {
        return {
          success: false,
          message: result.error || 'Failed to generate video',
          error: result.error
        };
      }

    } catch (error: any) {
      console.error('VideoService: Error generating video:', error);
      return {
        success: false,
        message: 'Failed to generate video',
        error: error.message
      };
    }
  }

  /**
   * Analyze/describe a video
   */
  async describeVideo(videoFileUrl: string, prompt?: string): Promise<any> {
    let tempDirPath: string | null = null;
    let uploadedFileName: string | null = null;
    let aiClient: any = null;

    try {
      if (!videoFileUrl) {
        return {
          success: false,
          message: 'No video URL provided'
        };
      }

      const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
      const geminiSecretName = `${environment}/AgentWeb/GeminiAPIKey`;
      const geminiApiKey = await getSecret(geminiSecretName);

      if (!geminiApiKey || !geminiApiKey.trim()) {
        return {
          success: false,
          message: 'Gemini API key is empty'
        };
      }

      const { GoogleGenAI } = await import('@google/genai');
      aiClient = new GoogleGenAI({ apiKey: geminiApiKey.trim() });

      const modelName = 'gemini-3-flash-preview';
      const analysisPrompt = prompt || 'Please describe this video in detail. Focus on key events, visual elements, and any spoken content.';
      const url = new URL(videoFileUrl);
      const hostname = (url.hostname || '').toLowerCase();
      const isYoutube = hostname.includes('youtube.com') || hostname.includes('youtu.be');

      let contents: any;

      if (isYoutube) {
        contents = [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: videoFileUrl
                }
              },
              { text: analysisPrompt }
            ]
          }
        ];
      } else {
        const maxSizeMb = parseInt(process.env.MAX_DOWNLOADED_VIDEO_SIZE_MB || '100', 10);
        const maxSizeBytes = maxSizeMb * 1024 * 1024;

        const response = await axios.get(videoFileUrl, { responseType: 'stream' });
        const responseStream = response.data as Readable;
        const contentLengthHeader = response.headers['content-length'];
        const declaredSize = contentLengthHeader ? parseInt(contentLengthHeader.toString(), 10) : 0;
        if (declaredSize && declaredSize > maxSizeBytes) {
          return {
            success: false,
            message: `Video file too large for analysis: ${Math.round(declaredSize / (1024 * 1024))} MB exceeds limit of ${maxSizeMb} MB`
          };
        }

        const contentTypeHeader = (response.headers['content-type'] || '').toString();
        const urlExtension = path.extname(url.pathname).toLowerCase();
        const mimeTypeMap: Record<string, string> = {
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.webm': 'video/webm',
          '.ogg': 'video/ogg',
          '.m4v': 'video/x-m4v',
          '.avi': 'video/x-msvideo'
        };
        const fallbackMimeType = mimeTypeMap[urlExtension] || 'video/mp4';
        const mimeType = contentTypeHeader.startsWith('video/') ? contentTypeHeader : fallbackMimeType;

        tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agentweb-video-'));
        const fileExtension = urlExtension || '.mp4';
        const tempFilePath = path.join(tempDirPath, `video${fileExtension}`);

        const writer = createWriteStream(tempFilePath);
        let downloadedBytes = 0;
        await new Promise<void>((resolve, reject) => {
          responseStream.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (downloadedBytes > maxSizeBytes) {
              responseStream.destroy(new Error('Video file too large'));
            }
          });
          responseStream.on('error', reject);
          writer.on('error', reject);
          writer.on('finish', resolve);
          responseStream.pipe(writer);
        });

        if (downloadedBytes === 0) {
          return {
            success: false,
            message: 'Downloaded video file is empty'
          };
        }

        if (downloadedBytes > maxSizeBytes) {
          return {
            success: false,
            message: `Video file too large for analysis: ${Math.round(downloadedBytes / (1024 * 1024))} MB exceeds limit of ${maxSizeMb} MB`
          };
        }

        const uploadResponse = await aiClient.files.upload({
          file: tempFilePath,
          config: { mimeType }
        });

        const fileUri = uploadResponse.uri || uploadResponse.file?.uri;
        const uploadedMime = uploadResponse.mimeType || uploadResponse.file?.mimeType || mimeType;
        uploadedFileName = uploadResponse.name || uploadResponse.file?.name || fileUri || null;

        if (!fileUri) {
          return {
            success: false,
            message: 'Failed to upload video to Gemini Files API'
          };
        }

        if (uploadedFileName) {
          await this.waitForGeminiFileActive(aiClient, uploadedFileName);
        }

        contents = [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri,
                  mimeType: uploadedMime
                }
              },
              { text: analysisPrompt }
            ]
          }
        ];
      }

      const response = await aiClient.models.generateContent({
        model: modelName,
        contents
      });

      const description = response.text;

      if (!description) {
        return {
          success: false,
          message: 'No description returned from Gemini'
        };
      }

      return {
        success: true,
        description,
        videoUrl: videoFileUrl
      };

    } catch (error) {
      console.error('VideoService: Error describing video:', error);
      return {
        success: false,
        message: 'Failed to analyze video. Please check that the URL is accessible and contains a valid video.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      if (aiClient && uploadedFileName) {
        try {
          await aiClient.files.delete({ name: uploadedFileName });
        } catch (cleanupError) {
          try {
            await (aiClient.files as any).delete(uploadedFileName);
          } catch (fallbackError) {
            console.warn('VideoService: Failed to delete uploaded Gemini file:', fallbackError);
          }
        }
      }

      if (tempDirPath) {
        try {
          await fs.rm(tempDirPath, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn('VideoService: Failed to clean up temp video file:', cleanupError);
        }
      }
    }
  }

  private async waitForGeminiFileActive(aiClient: any, fileName: string): Promise<void> {
    const maxAttempts = 30;
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        let fileInfo: any;
        try {
          fileInfo = await aiClient.files.get({ name: fileName });
        } catch {
          fileInfo = await aiClient.files.get(fileName);
        }

        const state = fileInfo?.state || fileInfo?.file?.state;
        if (state === 'ACTIVE') {
          return;
        }

        if (state === 'FAILED') {
          throw new Error('Gemini file processing failed');
        }
      } catch (error) {
        if (attempt === maxAttempts) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Singleton instance
export const videoService = new VideoService();
