import { synthesizeSpeech, transcribeSpeech } from '../services/voiceService';

// Mock Google Cloud clients
const mockSynthesizeSpeech = jest.fn();
const mockRecognize = jest.fn();

jest.mock('@google-cloud/text-to-speech', () => ({
  TextToSpeechClient: jest.fn().mockImplementation(() => ({
    synthesizeSpeech: mockSynthesizeSpeech,
  })),
}));

jest.mock('@google-cloud/speech', () => ({
  SpeechClient: jest.fn().mockImplementation(() => ({
    recognize: mockRecognize,
  })),
}));

jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn().mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----\nMOCK\n-----END RSA PRIVATE KEY-----'),
}));

// Suppress console.error in tests
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  (console.error as jest.Mock).mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GCS_CLIENT_EMAIL = 'test@test.iam.gserviceaccount.com';
});

// ---------------------------------------------------------------------------
// synthesizeSpeech
// ---------------------------------------------------------------------------

describe('synthesizeSpeech', () => {
  it('returns MP3 buffer for valid text', async () => {
    const fakeAudio = Buffer.from('fake-mp3-bytes');
    mockSynthesizeSpeech.mockResolvedValueOnce([{ audioContent: fakeAudio }]);

    const result = await synthesizeSpeech('Hello, I am Emma.');

    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe('fake-mp3-bytes');
    expect(mockSynthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { text: 'Hello, I am Emma.' },
        voice: expect.objectContaining({
          languageCode: 'en-US',
          name: 'en-US-Chirp3-HD-Aoede',
        }),
        audioConfig: { audioEncoding: 'MP3' },
      })
    );
  });

  it('throws when TTS returns empty audioContent', async () => {
    mockSynthesizeSpeech.mockResolvedValueOnce([{ audioContent: null }]);

    await expect(synthesizeSpeech('Hello')).rejects.toThrow('TTS returned empty audio content');
  });

  it('propagates errors from Google Cloud TTS', async () => {
    mockSynthesizeSpeech.mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(synthesizeSpeech('Hello')).rejects.toThrow('quota exceeded');
  });
});

// ---------------------------------------------------------------------------
// transcribeSpeech
// ---------------------------------------------------------------------------

describe('transcribeSpeech', () => {
  it('returns transcript from valid audio', async () => {
    mockRecognize.mockResolvedValueOnce([{
      results: [
        { alternatives: [{ transcript: 'What is my marketing budget?' }] },
      ],
    }]);

    const result = await transcribeSpeech('base64audiodata==');

    expect(result).toBe('What is my marketing budget?');
    expect(mockRecognize).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          encoding: 'WEBM_OPUS',
          sampleRateHertz: 48000,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
        }),
        audio: { content: 'base64audiodata==' },
      })
    );
  });

  it('joins multiple result segments with a space', async () => {
    mockRecognize.mockResolvedValueOnce([{
      results: [
        { alternatives: [{ transcript: 'Hello Emma' }] },
        { alternatives: [{ transcript: 'how are you doing today' }] },
      ],
    }]);

    const result = await transcribeSpeech('base64==');
    expect(result).toBe('Hello Emma how are you doing today');
  });

  it('returns empty string when audio has no speech', async () => {
    mockRecognize.mockResolvedValueOnce([{ results: [] }]);

    const result = await transcribeSpeech('base64==');
    expect(result).toBe('');
  });

  it('handles null/undefined alternatives gracefully', async () => {
    mockRecognize.mockResolvedValueOnce([{
      results: [
        { alternatives: null },
        { alternatives: [{ transcript: 'valid segment' }] },
      ],
    }]);

    const result = await transcribeSpeech('base64==');
    expect(result).toBe('valid segment');
  });

  it('propagates errors from Google Cloud STT', async () => {
    mockRecognize.mockRejectedValueOnce(new Error('STT service unavailable'));

    await expect(transcribeSpeech('base64==')).rejects.toThrow('STT service unavailable');
  });
});
