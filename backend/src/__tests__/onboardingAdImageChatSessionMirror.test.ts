/**
 * Tests for onboardingAdImageChatSessionMirror — write a synthetic
 * agent ChatSession + assistant message so onboarding-generated ad
 * images flow through the same surfaces (gallery, heart, X) as
 * Emma-generated images.
 */

import { mirrorOnboardingAdImagesToChatSession } from "../services/onboardingAdImageChatSessionMirror";

class FakeChatbotDB {
  public createCalls: any[] = [];
  public addMessageCalls: Array<{ sessionId: string; message: any }> = [];
  public existingSessionId: string | null = null;

  createChatSession = jest.fn(
    async (
      _userId: string,
      _pageContent?: string,
      portalType?: string,
      pageIdentifier?: string,
      _selectedStartupId?: string,
      _workflowId?: string,
      _executionId?: string,
      _emailCampaignTaskId?: string,
      sessionType?: string
    ) => {
      const sessionId = `session-${this.createCalls.length + 1}`;
      this.createCalls.push({ portalType, pageIdentifier, sessionType });
      return { sessionId };
    }
  );

  getChatSession = jest.fn(async (sessionId: string) => {
    if (this.existingSessionId && sessionId === this.existingSessionId) {
      return { sessionId };
    }
    return null;
  });

  addMessageToSession = jest.fn(async (sessionId: string, message: any) => {
    this.addMessageCalls.push({ sessionId, message });
  });
}

const variants = [
  { id: "variant-1", imageUrl: "https://s3.example.com/a.png", prompt: "p1" },
  { id: "variant-2", imageUrl: "https://s3.example.com/b.png", prompt: "p2" },
  { id: "variant-3", imageUrl: "https://s3.example.com/c.png", prompt: "p3" },
];

describe("mirrorOnboardingAdImagesToChatSession", () => {
  it("creates a hidden agent session on first call and writes one assistant message with 3 generate_image toolCalls", async () => {
    const fake = new FakeChatbotDB();
    const sessionId = await mirrorOnboardingAdImagesToChatSession(
      "u1",
      variants,
      { chatbotDb: fake as any }
    );

    expect(sessionId).toBe("session-1");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]).toMatchObject({
      portalType: "agent",
      pageIdentifier: "onboarding-ad-image",
      sessionType: "image-generation",
    });

    expect(fake.addMessageCalls).toHaveLength(1);
    const msg = fake.addMessageCalls[0].message;
    expect(msg.role).toBe("assistant");
    expect(msg.metadata.toolCalls).toHaveLength(3);
    msg.metadata.toolCalls.forEach((tc: any, i: number) => {
      expect(tc.name).toBe("generate_image");
      expect(tc.result.success).toBe(true);
      expect(tc.result.imageUrl).toBe(variants[i].imageUrl);
    });
    // tool_calls field also populated for OpenAI-shape consumers.
    expect(msg.tool_calls).toHaveLength(3);
  });

  it("reuses an existing session when caller supplies an id that resolves", async () => {
    const fake = new FakeChatbotDB();
    fake.existingSessionId = "preexisting-session";

    const sessionId = await mirrorOnboardingAdImagesToChatSession(
      "u1",
      variants,
      {
        chatbotDb: fake as any,
        existingSessionId: "preexisting-session",
      }
    );

    expect(sessionId).toBe("preexisting-session");
    expect(fake.createCalls).toHaveLength(0); // No new session created
    expect(fake.addMessageCalls).toHaveLength(1);
    expect(fake.addMessageCalls[0].sessionId).toBe("preexisting-session");
  });

  it("creates a fresh session if the supplied existing id no longer resolves (dev table reset)", async () => {
    const fake = new FakeChatbotDB();
    fake.existingSessionId = null; // Stored id points at gone session

    const sessionId = await mirrorOnboardingAdImagesToChatSession(
      "u1",
      variants,
      {
        chatbotDb: fake as any,
        existingSessionId: "stale-id",
      }
    );

    expect(sessionId).toBe("session-1"); // Fresh session
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.addMessageCalls).toHaveLength(1);
  });

  it("throws on empty variants — caller must guard so the gallery never gets empty assistant messages", async () => {
    const fake = new FakeChatbotDB();
    await expect(
      mirrorOnboardingAdImagesToChatSession("u1", [], { chatbotDb: fake as any })
    ).rejects.toThrow(/non-empty variants/);
  });

  it("throws on missing userId", async () => {
    const fake = new FakeChatbotDB();
    await expect(
      mirrorOnboardingAdImagesToChatSession("", variants, {
        chatbotDb: fake as any,
      })
    ).rejects.toThrow(/userId/);
  });
});
