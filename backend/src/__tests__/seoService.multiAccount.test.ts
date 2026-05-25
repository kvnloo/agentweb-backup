/**
 * SEO Service – Multiple Account / Legacy Migration Support
 *
 * The migration helpers getGoogleAnalyticsProperties() and getClarityProjects()
 * were removed because all production analytics surfaces now resolve config via
 * resolveAnalyticsConfig(). These tests verify that resolveAnalyticsConfig
 * carries forward the same normalisation behaviour (new-format → legacy fallback
 * → empty) so no regression is introduced.
 */

// resolveAnalyticsConfig uses db helpers; stub them out so no real AWS calls happen.
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
import { userDb, orgDb } from "../services/db";

const mockGetOrgById = orgDb.getOrgById as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no org record, so resolveAnalyticsConfig uses the user's own bundle.
  mockGetOrgById.mockResolvedValue(null);
});

describe("SEO Service - Multiple Account Support (via resolveAnalyticsConfig)", () => {
  describe("GA4 property normalisation", () => {
    it("should return new array format when googleAnalyticsProperties exists", async () => {
      const user = {
        googleAnalyticsProperties: [
          { propertyId: "123456789", label: "Main Site" },
          { propertyId: "987654321", label: "Product Site" },
        ],
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.properties).toEqual([
        { propertyId: "123456789", label: "Main Site" },
        { propertyId: "987654321", label: "Product Site" },
      ]);
    });

    it("should migrate from legacy single googleAnalyticsPropertyId", async () => {
      const user = { googleAnalyticsPropertyId: "123456789" };
      const result = await resolveAnalyticsConfig(user);
      expect(result.properties).toEqual([
        { propertyId: "123456789", label: "Main Property" },
      ]);
    });

    it("should return empty array when no properties configured", async () => {
      const result = await resolveAnalyticsConfig({});
      expect(result.properties).toEqual([]);
    });

    it("should prefer new format over legacy when both exist", async () => {
      const user = {
        googleAnalyticsPropertyId: "111111111",
        googleAnalyticsProperties: [{ propertyId: "123456789", label: "Main Site" }],
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.properties).toEqual([{ propertyId: "123456789", label: "Main Site" }]);
    });

    it("should fallback to legacy when googleAnalyticsProperties is empty", async () => {
      const user = {
        googleAnalyticsPropertyId: "123456789",
        googleAnalyticsProperties: [],
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.properties).toEqual([
        { propertyId: "123456789", label: "Main Property" },
      ]);
    });
  });

  describe("Clarity project normalisation", () => {
    it("should return new array format when clarityProjects exists", async () => {
      const user = {
        clarityProjects: [
          { projectId: "ul13e4f7fe", label: "Main Site" },
          { projectId: "xk9f2d8a1b", label: "Product Site" },
        ],
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.clarityProjects).toEqual([
        { projectId: "ul13e4f7fe", label: "Main Site" },
        { projectId: "xk9f2d8a1b", label: "Product Site" },
      ]);
    });

    it("should migrate from legacy single clarityProjectId", async () => {
      const user = { clarityProjectId: "ul13e4f7fe" };
      const result = await resolveAnalyticsConfig(user);
      expect(result.clarityProjects).toEqual([
        { projectId: "ul13e4f7fe", label: "Main Project" },
      ]);
    });

    it("should return empty array when no projects configured", async () => {
      const result = await resolveAnalyticsConfig({});
      expect(result.clarityProjects).toEqual([]);
    });

    it("should prefer new format over legacy when both exist", async () => {
      const user = {
        clarityProjectId: "oldproject",
        clarityProjects: [{ projectId: "ul13e4f7fe", label: "Main Site" }],
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.clarityProjects).toEqual([
        { projectId: "ul13e4f7fe", label: "Main Site" },
      ]);
    });

    it("should fallback to legacy when clarityProjects is empty", async () => {
      const user = {
        clarityProjectId: "ul13e4f7fe",
        clarityProjects: [],
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.clarityProjects).toEqual([
        { projectId: "ul13e4f7fe", label: "Main Project" },
      ]);
    });
  });

  describe("Migration scenarios", () => {
    it("should handle user with both old and new formats correctly", async () => {
      const user = {
        googleAnalyticsPropertyId: "111111111",
        clarityProjectId: "oldproject",
        googleAnalyticsProperties: [
          { propertyId: "123456789", label: "Main Site" },
          { propertyId: "987654321", label: "Product Site" },
        ],
        clarityProjects: [{ projectId: "ul13e4f7fe", label: "Main Site" }],
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.properties).toHaveLength(2);
      expect(result.properties[0].propertyId).toBe("123456789");
      expect(result.clarityProjects).toHaveLength(1);
      expect(result.clarityProjects[0].projectId).toBe("ul13e4f7fe");
    });

    it("should handle user with only legacy formats", async () => {
      const user = {
        googleAnalyticsPropertyId: "111111111",
        clarityProjectId: "oldproject",
      };
      const result = await resolveAnalyticsConfig(user);
      expect(result.properties).toEqual([
        { propertyId: "111111111", label: "Main Property" },
      ]);
      expect(result.clarityProjects).toEqual([
        { projectId: "oldproject", label: "Main Project" },
      ]);
    });
  });
});
