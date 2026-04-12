import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { SpeechClient } from '@google-cloud/speech';
import { getGCSPPrivateKey } from '../utils/secretsManager';

// Chirp 3 HD voice — warm, conversational, designed for real-time apps
const TTS_VOICE_NAME = 'en-US-Chirp3-HD-Aoede';
const TTS_LANGUAGE_CODE = 'en-US';

// Cache credentials and clients — private key doesn't change at runtime
let cachedCredentials: { client_email: string; private_key: string } | null = null;
let ttsClient: TextToSpeechClient | null = null;
let sttClient: SpeechClient | null = null;

async function getClients() {
  if (!cachedCredentials) {
    const privateKey = await getGCSPPrivateKey();
    cachedCredentials = {
      client_email: process.env.GCS_CLIENT_EMAIL as string,
      private_key: privateKey,
    };
  }
  if (!ttsClient) ttsClient = new TextToSpeechClient({ credentials: cachedCredentials });
  if (!sttClient) sttClient = new SpeechClient({ credentials: cachedCredentials });
  return { ttsClient, sttClient };
}

/**
 * Convert text to speech using Google Cloud TTS (Chirp 3 HD).
 * Returns raw MP3 bytes.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const { ttsClient: client } = await getClients();

  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: TTS_LANGUAGE_CODE,
      name: TTS_VOICE_NAME,
    },
    audioConfig: {
      audioEncoding: 'MP3',
    },
  });

  if (!response.audioContent) {
    throw new Error('TTS returned empty audio content');
  }

  return Buffer.from(response.audioContent as Uint8Array);
}

/**
 * Transcribe speech audio to text using Google Cloud STT.
 * Accepts base64-encoded audio in webm/opus format (browser MediaRecorder default).
 */
export async function transcribeSpeech(audioBase64: string): Promise<string> {
  const { sttClient: client } = await getClients();

  const [response] = await client.recognize({
    config: {
      encoding: 'WEBM_OPUS' as const,
      sampleRateHertz: 48000,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
    },
    audio: {
      content: audioBase64,
    },
  });

  const transcript = (response.results || [])
    .map((r) => r.alternatives?.[0]?.transcript ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();

  return transcript;
}
