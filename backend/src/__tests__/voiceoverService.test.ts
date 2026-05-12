// Tests for voiceoverService — ElevenLabs TTS + ffmpeg mux pipeline.

jest.mock("../utils/secretsManager", () => ({
  getElevenLabsApiKey: jest.fn().mockResolvedValue("xi_test_key"),
}));

jest.mock("../utils/s3Utils", () => ({
  uploadFileToS3: jest.fn(),
}));

jest.mock("axios");

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  chmodSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import { generateVoiceover, listVoices, muxVideoWithAudio, VOICE_PRESETS } from "../services/voiceoverService";
import { uploadFileToS3 } from "../utils/s3Utils";
import * as fs from "fs";
import { spawn } from "child_process";
// Use `any` so TypeScript doesn't complain about partial AxiosResponse shapes in mocks
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAxios: any = jest.requireMock("axios");
const mockUploadFileToS3 = uploadFileToS3 as jest.Mock;
const mockSpawn = spawn as jest.Mock;
const mockFs = fs as jest.Mocked<typeof fs>;

const FAKE_AUDIO = Buffer.from("fake-mp3-bytes");
const USER_ID = "user-test";

beforeEach(() => {
  jest.clearAllMocks();
  mockUploadFileToS3.mockResolvedValue({ success: true, url: "https://s3.example.com/audio.mp3" });
  mockAxios.post.mockResolvedValue({ data: FAKE_AUDIO });
});

// ─── generateVoiceover — validation ──────────────────────────────────────────

describe("generateVoiceover — input validation", () => {
  it("returns error when script is empty string", async () => {
    const result = await generateVoiceover("", "test.mp3", USER_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Script is required/);
  });

  it("returns error when script is whitespace only", async () => {
    const result = await generateVoiceover("   ", "test.mp3", USER_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Script is required/);
  });

  it("returns error when filename is empty string", async () => {
    const result = await generateVoiceover("Hello world", "", USER_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Filename is required/);
  });
});

// ─── generateVoiceover — voice resolution ────────────────────────────────────

describe("generateVoiceover — voice resolution", () => {
  it("auto-appends .mp3 extension when missing", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    const result = await generateVoiceover("Hello", "my-clip", USER_ID);
    expect(result.success).toBe(true);
    expect(result.filename).toBe("my-clip.mp3");
  });

  it("does not double-append .mp3 when already present", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    const result = await generateVoiceover("Hello", "clip.mp3", USER_ID);
    expect(result.success).toBe(true);
    expect(result.filename).toBe("clip.mp3");
  });

  it("uses preset voiceId when voiceName matches a known preset", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    const result = await generateVoiceover("Hello", "clip.mp3", USER_ID, "rachel");
    expect(result.success).toBe(true);
    expect(result.voiceId).toBe(VOICE_PRESETS.rachel.voiceId);
  });

  it("accepts preset name case-insensitively", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    const result = await generateVoiceover("Hello", "clip.mp3", USER_ID, "GEORGE");
    expect(result.success).toBe(true);
    expect(result.voiceId).toBe(VOICE_PRESETS.george.voiceId);
  });

  it("uses raw voiceId when it looks like an ElevenLabs ID (20+ alphanumeric chars)", async () => {
    const rawId = "AbCdEfGhIjKlMnOpQrSt"; // 20 chars
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    const result = await generateVoiceover("Hello", "clip.mp3", USER_ID, rawId);
    expect(result.success).toBe(true);
    expect(result.voiceId).toBe(rawId);
  });

  it("falls back to default voice when voiceName is unknown short string", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    const result = await generateVoiceover("Hello", "clip.mp3", USER_ID, "unknown-voice");
    expect(result.success).toBe(true);
    // Still succeeds with default voice
    expect(result.voiceId).toBeDefined();
  });
});

// ─── generateVoiceover — success path ────────────────────────────────────────

describe("generateVoiceover — success", () => {
  it("returns audioUrl, filename, voiceId and estimated duration", async () => {
    const fakeBuffer = Buffer.alloc(32000); // ~2 seconds at 128kbps
    mockAxios.post.mockResolvedValueOnce({ data: fakeBuffer });
    mockUploadFileToS3.mockResolvedValueOnce({ success: true, url: "https://s3.example.com/vo.mp3" });

    const result = await generateVoiceover("Say something", "vo.mp3", USER_ID);

    expect(result.success).toBe(true);
    expect(result.audioUrl).toBe("https://s3.example.com/vo.mp3");
    expect(result.filename).toBe("vo.mp3");
    expect(result.durationSeconds).toBe(2);
  });

  it("passes xi-api-key header to ElevenLabs", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    await generateVoiceover("Hello", "clip.mp3", USER_ID);

    expect(mockAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("text-to-speech"),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ "xi-api-key": "xi_test_key" }),
      })
    );
  });

  it("uploads audio to S3 under the user's path", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    await generateVoiceover("Hello", "clip.mp3", USER_ID);

    expect(mockUploadFileToS3).toHaveBeenCalledWith(
      expect.any(Buffer),
      "clip.mp3",
      USER_ID,
      "audio/mpeg"
    );
  });
});

// ─── generateVoiceover — error paths ─────────────────────────────────────────

describe("generateVoiceover — errors", () => {
  it("returns failure when ElevenLabs API throws", async () => {
    mockAxios.post.mockRejectedValueOnce(new Error("ElevenLabs 429 Too Many Requests"));

    const result = await generateVoiceover("Hello", "clip.mp3", USER_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Voiceover generation failed/);
  });

  it("returns failure when S3 upload fails", async () => {
    mockAxios.post.mockResolvedValueOnce({ data: FAKE_AUDIO });
    mockUploadFileToS3.mockResolvedValueOnce({ success: false, error: "S3 write error" });

    const result = await generateVoiceover("Hello", "clip.mp3", USER_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/S3 write error/);
  });
});

// ─── listVoices ───────────────────────────────────────────────────────────────

describe("listVoices", () => {
  it("returns mapped voice list on success", async () => {
    mockAxios.get.mockResolvedValueOnce({
      data: {
        voices: [
          { voice_id: "v1", name: "Voice One", category: "premade" },
          { voice_id: "v2", name: "Voice Two", category: "cloned" },
        ],
      },
    });

    const voices = await listVoices();

    expect(voices).toHaveLength(2);
    expect(voices[0]).toEqual({ voiceId: "v1", name: "Voice One", category: "premade" });
    expect(voices[1]).toEqual({ voiceId: "v2", name: "Voice Two", category: "cloned" });
  });

  it("returns empty array on API error", async () => {
    mockAxios.get.mockRejectedValueOnce(new Error("ElevenLabs down"));
    const voices = await listVoices();
    expect(voices).toEqual([]);
  });
});

// ─── muxVideoWithAudio ────────────────────────────────────────────────────────

describe("muxVideoWithAudio", () => {
  const FAKE_VIDEO_URL = "https://s3.example.com/video.mp4";
  const FAKE_AUDIO_URL = "https://s3.example.com/audio.mp3";

  function makeSpawnMock(exitCode: number, stderrMsg = "") {
    const emitter: any = {
      stderr: { on: jest.fn() },
      on: jest.fn(),
    };
    emitter.stderr.on.mockImplementation((_event: string, cb: (d: Buffer) => void) => {
      if (stderrMsg) cb(Buffer.from(stderrMsg));
    });
    emitter.on.mockImplementation((event: string, cb: (...args: any[]) => void) => {
      if (event === "close") setTimeout(() => cb(exitCode), 0);
      if (event === "error") { /* not called */ }
    });
    return emitter;
  }

  it("auto-appends .mp4 extension when missing", async () => {
    mockAxios.get.mockResolvedValue({ data: Buffer.from("fake") });
    (mockFs.readFileSync as jest.Mock).mockReturnValue(Buffer.from("muxed"));
    mockSpawn.mockReturnValue(makeSpawnMock(0));
    mockUploadFileToS3.mockResolvedValueOnce({ success: true, url: "https://s3.example.com/out.mp4" });

    const result = await muxVideoWithAudio(FAKE_VIDEO_URL, FAKE_AUDIO_URL, "output", USER_ID);

    expect(result.success).toBe(true);
    expect(result.filename).toBe("output.mp4");
  });

  it("returns failure when ffmpeg exits non-zero", async () => {
    mockAxios.get.mockResolvedValue({ data: Buffer.from("fake") });
    mockSpawn.mockReturnValue(makeSpawnMock(1, "ffmpeg error: no such file"));

    const result = await muxVideoWithAudio(FAKE_VIDEO_URL, FAKE_AUDIO_URL, "output.mp4", USER_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mux failed/i);
  });

  it("returns failure when S3 upload of muxed video fails", async () => {
    mockAxios.get.mockResolvedValue({ data: Buffer.from("fake") });
    (mockFs.readFileSync as jest.Mock).mockReturnValue(Buffer.from("muxed"));
    mockSpawn.mockReturnValue(makeSpawnMock(0));
    mockUploadFileToS3.mockResolvedValueOnce({ success: false, error: "S3 quota exceeded" });

    const result = await muxVideoWithAudio(FAKE_VIDEO_URL, FAKE_AUDIO_URL, "output.mp4", USER_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/S3 quota exceeded/);
  });
});
