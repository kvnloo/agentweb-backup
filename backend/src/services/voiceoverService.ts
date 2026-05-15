import axios from 'axios';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getElevenLabsApiKey } from '../utils/secretsManager';
import { uploadFileToS3 } from '../utils/s3Utils';

// Remotion ships its own ffmpeg binary — use it so we don't need a system install
const FFMPEG_BIN = path.join(
  __dirname,
  '../../node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg'
);

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// High-quality English voices suitable for ad voiceovers
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George — warm, confident male voice
export const VOICE_PRESETS: Record<string, { voiceId: string; description: string }> = {
  george:   { voiceId: 'JBFqnCBsd6RMkjVDRZzb', description: 'Warm, confident male — great for ads' },
  rachel:   { voiceId: '21m00Tcm4TlvDq8ikWAM', description: 'Clear, professional female' },
  adam:     { voiceId: 'pNInz6obpgDQGcFmaJgB', description: 'Deep, authoritative male' },
  bella:    { voiceId: 'EXAVITQu4vr4xnSDxMaL', description: 'Soft, friendly female' },
  josh:     { voiceId: 'TxGEqnHWrfWFTfGW9XjX', description: 'Young, energetic male' },
  dorothy:  { voiceId: 'ThT5KcBeYPX3keUQqHPh', description: 'Pleasant, conversational female' },
};

export interface VoiceoverResult {
  success: boolean;
  audioUrl?: string;
  filename?: string;
  durationSeconds?: number;
  voiceId?: string;
  error?: string;
}

let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (!cachedApiKey) {
    cachedApiKey = await getElevenLabsApiKey();
  }
  return cachedApiKey;
}

/**
 * Generate voiceover audio from a script using ElevenLabs TTS.
 * Returns an S3 URL to the generated MP3 file.
 */
export async function generateVoiceover(
  script: string,
  filename: string,
  userId: string,
  voiceName?: string,
  stabilityOverride?: number,
  similarityBoostOverride?: number
): Promise<VoiceoverResult> {
  try {
    if (!script || !script.trim()) {
      return { success: false, error: 'Script is required for voiceover generation' };
    }
    if (!filename || !filename.trim()) {
      return { success: false, error: 'Filename is required' };
    }

    if (!filename.toLowerCase().endsWith('.mp3')) {
      filename = `${filename}.mp3`;
    }

    const apiKey = await getApiKey();

    // Resolve voice — accept preset name or direct ElevenLabs voice ID
    let voiceId = DEFAULT_VOICE_ID;
    if (voiceName) {
      const lower = voiceName.toLowerCase();
      if (VOICE_PRESETS[lower]) {
        voiceId = VOICE_PRESETS[lower].voiceId;
      } else if (/^[a-zA-Z0-9]{20,}$/.test(voiceName)) {
        // Looks like a raw ElevenLabs voice ID
        voiceId = voiceName;
      }
    }

    const stability = stabilityOverride ?? 0.5;
    const similarityBoost = similarityBoostOverride ?? 0.75;

    console.log(`VoiceoverService: Generating voiceover with voice=${voiceId}, script length=${script.length}`);

    const response = await axios.post(
      `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`,
      {
        text: script,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
        },
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
      }
    );

    const audioBuffer = Buffer.from(response.data as ArrayBuffer);
    console.log(`VoiceoverService: Generated ${audioBuffer.length} bytes of audio`);

    const uploadResult = await uploadFileToS3(audioBuffer, filename, userId, 'audio/mpeg');
    if (!uploadResult.success || !uploadResult.url) {
      return { success: false, error: uploadResult.error || 'Failed to upload audio to S3' };
    }

    // Estimate duration: MP3 at 128kbps ≈ 16000 bytes/sec
    const estimatedDurationSeconds = Math.round(audioBuffer.length / 16000);

    console.log(`VoiceoverService: Uploaded to ${uploadResult.url}`);
    return {
      success: true,
      audioUrl: uploadResult.url,
      filename,
      durationSeconds: estimatedDurationSeconds,
      voiceId,
    };
  } catch (error: any) {
    const detail = error.response?.data
      ? Buffer.isBuffer(error.response.data)
        ? error.response.data.toString('utf8')
        : JSON.stringify(error.response.data)
      : error.message;
    console.error('VoiceoverService: Error generating voiceover:', detail);
    return { success: false, error: `Voiceover generation failed: ${detail}` };
  }
}

/**
 * List available ElevenLabs voices for the configured API key.
 */
export async function listVoices(): Promise<{ voiceId: string; name: string; category: string }[]> {
  try {
    const apiKey = await getApiKey();
    const response = await axios.get(`${ELEVENLABS_API_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey },
      timeout: 10000,
    });
    const data = response.data as any;
    return (data.voices || []).map((v: any) => ({
      voiceId: v.voice_id,
      name: v.name,
      category: v.category || 'premade',
    }));
  } catch (error: any) {
    console.error('VoiceoverService: Error listing voices:', error.message);
    return [];
  }
}

export interface MuxResult {
  success: boolean;
  videoUrl?: string;
  filename?: string;
  error?: string;
}

/**
 * Download a file from an S3 URL to a temp path.
 */
async function downloadToTemp(url: string, ext: string): Promise<string> {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
  const tmpPath = path.join(os.tmpdir(), `remotion-mux-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(response.data as ArrayBuffer));
  return tmpPath;
}

/**
 * Mux a video file (MP4) with a voiceover audio file (MP3) using ffmpeg.
 * The audio is trimmed/padded to match the video duration.
 * Returns an S3 URL to the final muxed MP4.
 */
export async function muxVideoWithAudio(
  videoUrl: string,
  audioUrl: string,
  outputFilename: string,
  userId: string
): Promise<MuxResult> {
  let videoPath: string | null = null;
  let audioPath: string | null = null;
  let outputPath: string | null = null;

  try {
    if (!outputFilename.toLowerCase().endsWith('.mp4')) {
      outputFilename = `${outputFilename}.mp4`;
    }

    console.log(`VoiceoverService: Downloading video and audio for mux...`);
    [videoPath, audioPath] = await Promise.all([
      downloadToTemp(videoUrl, '.mp4'),
      downloadToTemp(audioUrl, '.mp3'),
    ]);

    outputPath = path.join(os.tmpdir(), `muxed-${Date.now()}.mp4`);

    // Ensure the ffmpeg binary is executable
    try { fs.chmodSync(FFMPEG_BIN, 0o755); } catch {}

    console.log(`VoiceoverService: Muxing video + audio with ffmpeg...`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN, [
        '-y',
        '-i', videoPath!,
        '-i', audioPath!,
        // Map video from first input, audio from second
        '-map', '0:v:0',
        '-map', '1:a:0',
        // Copy video stream, re-encode audio to AAC for MP4 compatibility
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        // Trim audio to video duration (shortest wins)
        '-shortest',
        outputPath!,
      ]);

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });

    const muxedBuffer = fs.readFileSync(outputPath);
    console.log(`VoiceoverService: Muxed video is ${muxedBuffer.length} bytes`);

    const uploadResult = await uploadFileToS3(muxedBuffer, outputFilename, userId, 'video/mp4');
    if (!uploadResult.success || !uploadResult.url) {
      return { success: false, error: uploadResult.error || 'Failed to upload muxed video to S3' };
    }

    console.log(`VoiceoverService: Muxed video uploaded to ${uploadResult.url}`);
    return { success: true, videoUrl: uploadResult.url, filename: outputFilename };
  } catch (error: any) {
    console.error('VoiceoverService: Mux error:', error.message);
    return { success: false, error: `Video+audio mux failed: ${error.message}` };
  } finally {
    for (const p of [videoPath, audioPath, outputPath]) {
      if (p) { try { fs.unlinkSync(p); } catch {} }
    }
  }
}

export async function isAvailable(): Promise<boolean> {
  try {
    await getApiKey();
    return true;
  } catch {
    return false;
  }
}
