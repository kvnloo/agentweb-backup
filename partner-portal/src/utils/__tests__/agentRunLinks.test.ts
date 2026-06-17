import { AGENT_RUNS_PATH, buildAgentRunInspectorUrl } from "../agentRunLinks";

describe("agent run inspector links", () => {
  it("keeps the inspector mounted at the partner portal agent-runs path", () => {
    expect(AGENT_RUNS_PATH).toBe("/agent-runs");
  });

  it("deep-links a chat session into the inspector", () => {
    expect(buildAgentRunInspectorUrl({ sessionId: "session-123" })).toBe(
      "/agent-runs?sessionId=session-123"
    );
  });

  it("encodes session IDs before placing them in the query string", () => {
    expect(buildAgentRunInspectorUrl({ sessionId: "session with spaces" })).toBe(
      "/agent-runs?sessionId=session+with+spaces"
    );
  });

  it("can carry run, session, and user filters together", () => {
    expect(
      buildAgentRunInspectorUrl({
        runId: "run-1",
        sessionId: "session-1",
        userId: "user-1",
      })
    ).toBe("/agent-runs?runId=run-1&sessionId=session-1&userId=user-1");
  });
});
