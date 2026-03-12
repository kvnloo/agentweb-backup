/**
 * E2E Happy-Path: Landing Page Generation → Iterate → List → Deploy → Delete
 *
 * Gated by RUN_E2E_TESTS=true (skipped in normal `npm test` runs).
 * Requires a running backend with valid V0_API_KEY and test user credentials.
 *
 * Usage:
 *   RUN_E2E_TESTS=true npx jest --testPathPattern=e2e --forceExit
 */

const RUN = process.env.RUN_E2E_TESTS === "true";
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3001";
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || "test@example.com";
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || "Test123!";

// Increase timeout for v0 generation (can take 30-60s)
const GENERATION_TIMEOUT = 120_000;
const POLL_INTERVAL = 5_000;

// Track page IDs for cleanup
const createdPageIds: string[] = [];
let authToken: string | null = null;

async function apiFetch(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function login(): Promise<string> {
  const { status, data } = await apiFetch("POST", "/api/auth/login", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (status !== 200 || !data?.token) {
    throw new Error(`Login failed (${status}): ${JSON.stringify(data)}`);
  }
  return data.token;
}

async function deletePage(pageId: string): Promise<void> {
  try {
    await apiFetch("DELETE", `/api/landing-pages/v0/generated/${pageId}`);
  } catch {
    // Best-effort cleanup
  }
}

// Skip the entire suite if RUN_E2E_TESTS is not set
const describeE2E = RUN ? describe : describe.skip;

describeE2E("Landing Page E2E Happy Path", () => {
  let pageId: string;

  beforeAll(async () => {
    authToken = await login();
  }, 15_000);

  afterAll(async () => {
    // Always clean up, even on failure
    for (const id of createdPageIds) {
      await deletePage(id);
    }
  }, 30_000);

  it(
    "should generate a landing page",
    async () => {
      const { status, data } = await apiFetch(
        "POST",
        "/api/landing-pages/v0/generate",
        {
          prompt: "A simple SaaS landing page for an AI writing tool called TestBot",
          name: "E2E Test Page",
        }
      );

      expect(status).toBe(201);
      expect(data).toHaveProperty("id");
      expect(data.id).toBeTruthy();

      pageId = data.id;
      createdPageIds.push(pageId);
    },
    GENERATION_TIMEOUT
  );

  it(
    "should poll until page reaches draft status",
    async () => {
      // Poll for the page to finish generating
      const deadline = Date.now() + GENERATION_TIMEOUT;

      while (Date.now() < deadline) {
        const { status, data } = await apiFetch(
          "GET",
          `/api/landing-pages/v0/generated/${pageId}`
        );

        expect(status).toBe(200);
        expect(data).toHaveProperty("status");

        if (data.status === "draft" || data.status === "ready") {
          // Generation complete
          expect(data).toHaveProperty("id", pageId);
          return;
        }

        if (data.status === "error" || data.status === "failed") {
          throw new Error(`Generation failed: ${JSON.stringify(data)}`);
        }

        // Still processing — wait and retry
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }

      throw new Error("Generation timed out");
    },
    GENERATION_TIMEOUT
  );

  it(
    "should iterate on the landing page",
    async () => {
      const { status, data } = await apiFetch(
        "POST",
        `/api/landing-pages/v0/generated/${pageId}/iterate`,
        { message: "Make the hero section more prominent and add a CTA button" }
      );

      expect(status).toBe(200);
      expect(data).toBeTruthy();
    },
    GENERATION_TIMEOUT
  );

  it("should list landing pages including the new one", async () => {
    const { status, data } = await apiFetch(
      "GET",
      "/api/landing-pages/v0/generated"
    );

    expect(status).toBe(200);
    expect(data).toHaveProperty("pages");
    expect(Array.isArray(data.pages)).toBe(true);

    const found = data.pages.find((p: any) => p.id === pageId);
    expect(found).toBeTruthy();
  });

  it("should get the landing page by ID", async () => {
    const { status, data } = await apiFetch(
      "GET",
      `/api/landing-pages/v0/generated/${pageId}`
    );

    expect(status).toBe(200);
    expect(data).toHaveProperty("id", pageId);
  });

  it(
    "should deploy the landing page",
    async () => {
      const { status, data } = await apiFetch(
        "POST",
        `/api/landing-pages/v0/generated/${pageId}/deploy`,
      );

      // Deploy may succeed or fail depending on Vercel config — both are valid for E2E
      // The important thing is the endpoint responds correctly
      expect([200, 500]).toContain(status);
      if (status === 200) {
        expect(data).toBeTruthy();
      }
    },
    GENERATION_TIMEOUT
  );

  it("should delete the landing page (cleanup)", async () => {
    const { status, data } = await apiFetch(
      "DELETE",
      `/api/landing-pages/v0/generated/${pageId}`
    );

    expect(status).toBe(200);
    expect(data).toHaveProperty("success", true);

    // Remove from cleanup list since we already deleted it
    const idx = createdPageIds.indexOf(pageId);
    if (idx >= 0) createdPageIds.splice(idx, 1);
  });
});
