/**
 * ENG-2307 — installing a Meta Pixel with no ad account must not 500.
 *
 * `POST /generated/:id/meta-pixel` treats `accountId` as optional — a standalone
 * landing page (not tied to a specific ad campaign) can carry a pixel ID with no
 * associated Meta ad account. `updateLandingPageMetaPixel` always referenced `:acc`
 * in its UpdateExpression regardless, and the AWS SDK silently drops an `undefined`
 * value from ExpressionAttributeValues — so DynamoDB rejected the whole update as
 * referencing an undefined placeholder.
 *
 * Same distinction ENG-1525 pinned for the Google Ads sibling: `undefined` means
 * "the caller did not mention this field", `""` means "the caller asked to clear it".
 */

const mockDynamoInstance = {
  put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
  update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
};

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => mockDynamoInstance) },
    S3: jest.fn().mockImplementation(() => ({})),
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () => Promise.resolve({ SecretString: '{"token":"gh-token","org":"AgentWebPro"}' }),
      }),
    })),
    config: { update: jest.fn() },
  },
  S3: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../utils/secretsManager", () => ({
  getVercelToken: jest.fn().mockResolvedValue("t"),
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "gh", org: "AgentWebPro" }),
}));

import { updateLandingPageMetaPixel } from "../services/v0Service";

const PIXEL = "999000111222333";
const ACCOUNT = "act_2883029950";
const PAGE = { id: "page-1", userId: "user-1", metaPixelId: PIXEL, metaAdAccountId: ACCOUNT };

/** The function reads the record back first; give it one. */
function seedRecord() {
  mockDynamoInstance.get.mockReturnValue({ promise: () => Promise.resolve({ Item: PAGE }) });
  mockDynamoInstance.query.mockReturnValue({ promise: () => Promise.resolve({ Items: [PAGE] }) });
}

function lastUpdate() {
  const calls = mockDynamoInstance.update.mock.calls;
  return calls[calls.length - 1][0] as { UpdateExpression: string; ExpressionAttributeValues: Record<string, any> };
}

beforeEach(() => {
  jest.clearAllMocks();
  seedRecord();
});

describe("ENG-2307 — a pixel with no ad account is a legitimate state, not bad input", () => {
  it("does not 500 when accountId is omitted — no dangling :acc placeholder", async () => {
    await expect(updateLandingPageMetaPixel("page-1", "user-1", PIXEL)).resolves.not.toThrow();
    const call = lastUpdate();
    expect(call.UpdateExpression).not.toMatch(/:acc/);
    expect(call.ExpressionAttributeValues).not.toHaveProperty(":acc");
    expect(call.UpdateExpression).toMatch(/SET[\s\S]*metaPixelId/);
    expect(call.UpdateExpression).not.toMatch(/REMOVE[\s\S]*metaAdAccountId/);
  });

  it("still writes the account when one IS supplied", async () => {
    await updateLandingPageMetaPixel("page-1", "user-1", PIXEL, ACCOUNT);
    const call = lastUpdate();
    expect(call.UpdateExpression).toMatch(/metaAdAccountId = :acc/);
    expect(call.ExpressionAttributeValues[":acc"]).toBe(ACCOUNT);
    expect(call.UpdateExpression).not.toMatch(/REMOVE/);
  });

  it("removes the account when it is explicitly cleared with an empty string", async () => {
    await updateLandingPageMetaPixel("page-1", "user-1", PIXEL, "");
    const call = lastUpdate();
    expect(call.UpdateExpression).toMatch(/REMOVE[\s\S]*metaAdAccountId/);
  });

  it("still clears both when the pixel id itself is removed", async () => {
    await updateLandingPageMetaPixel("page-1", "user-1", "");
    const call = lastUpdate();
    expect(call.UpdateExpression).toMatch(/REMOVE metaPixelId, metaAdAccountId/);
  });
});
