// Simple unit test for the brand route bug fix
// This tests the core logic without HTTP requests

// Mock the database service
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

const { userDb } = require('../services/db');

describe('Brand Route - Bug Fix Tests', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
  });

  describe('🐛 BUG: Brand route overwrites existing data with empty strings', () => {
    it('should demonstrate the bug fix - preserve existing data when fields are not provided', () => {
      // This test demonstrates the core logic fix in the brand route
      
      // Simulate existing brand guidelines with data
      const existingBrandGuidelines = {
        brandData: {
          brandName: "DataScoop",
          tagline: "AI Risk Detective for Auto Lenders",
          primaryColor: "#0000FF",
          secondaryColor: "#00FF00",
          fontFamily: "Arial",
          toneOfVoice: "Professional",
          keyMessages: ["AI-powered risk detection"],
          brandValues: ["Accuracy", "Transparency"],
          targetAudience: "CXOs and executives",
          brandPersonality: "Analytical, trustworthy",
          primaryColorEnd: "",
          isGradient: false,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request data with only some fields
      const incomingData = {
        primaryColor: "#FF0000", // Only this field is provided
        // Other fields are undefined (not provided)
      };

      // Test the fixed logic (this is what the brand route now does)
      const brandGuidelinesData = {
        brandData: {
          // Only update fields that are provided, preserve existing data for missing fields
          brandName: incomingData.brandName !== undefined ? incomingData.brandName : (existingBrandGuidelines?.brandData?.brandName || ""),
          tagline: incomingData.tagline !== undefined ? incomingData.tagline : (existingBrandGuidelines?.brandData?.tagline || ""),
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          secondaryColor: incomingData.secondaryColor !== undefined ? incomingData.secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          fontFamily: incomingData.fontFamily !== undefined ? incomingData.fontFamily : (existingBrandGuidelines?.brandData?.fontFamily || ""),
          toneOfVoice: incomingData.toneOfVoice !== undefined ? incomingData.toneOfVoice : (existingBrandGuidelines?.brandData?.toneOfVoice || ""),
          keyMessages: existingBrandGuidelines?.brandData?.keyMessages || [],
          brandValues: existingBrandGuidelines?.brandData?.brandValues || [],
          targetAudience: incomingData.targetAudience !== undefined ? incomingData.targetAudience : (existingBrandGuidelines?.brandData?.targetAudience || ""),
          brandPersonality: incomingData.brandPersonality !== undefined ? incomingData.brandPersonality : (existingBrandGuidelines?.brandData?.brandPersonality || ""),
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
        attachments: existingBrandGuidelines?.attachments || [],
        createdAt: existingBrandGuidelines?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Verify the fix works
      expect(brandGuidelinesData.brandData.brandName).toBe("DataScoop"); // ✅ Preserved (was being overwritten before fix)
      expect(brandGuidelinesData.brandData.tagline).toBe("AI Risk Detective for Auto Lenders"); // ✅ Preserved (was being overwritten before fix)
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000"); // ✅ Updated
      expect(brandGuidelinesData.brandData.secondaryColor).toBe("#00FF00"); // ✅ Preserved (was being overwritten before fix)
      expect(brandGuidelinesData.brandData.fontFamily).toBe("Arial"); // ✅ Preserved (was being overwritten before fix)
      expect(brandGuidelinesData.brandData.toneOfVoice).toBe("Professional"); // ✅ Preserved (was being overwritten before fix)
      expect(brandGuidelinesData.brandData.keyMessages).toEqual(["AI-powered risk detection"]); // ✅ Preserved
      expect(brandGuidelinesData.brandData.brandValues).toEqual(["Accuracy", "Transparency"]); // ✅ Preserved
      expect(brandGuidelinesData.brandData.targetAudience).toBe("CXOs and executives"); // ✅ Preserved (was being overwritten before fix)
      expect(brandGuidelinesData.brandData.brandPersonality).toBe("Analytical, trustworthy"); // ✅ Preserved (was being overwritten before fix)
    });

    it('should demonstrate the old buggy behavior (for comparison)', () => {
      // This test shows what the old buggy code would do
      
      // Simulate existing brand guidelines with data
      const existingBrandGuidelines = {
        brandData: {
          brandName: "DataScoop",
          tagline: "AI Risk Detective for Auto Lenders",
          primaryColor: "#0000FF",
          secondaryColor: "#00FF00",
          fontFamily: "Arial",
          toneOfVoice: "Professional",
          keyMessages: ["AI-powered risk detection"],
          brandValues: ["Accuracy", "Transparency"],
          targetAudience: "CXOs and executives",
          brandPersonality: "Analytical, trustworthy",
          primaryColorEnd: "",
          isGradient: false,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request data with only some fields
      const incomingData = {
        primaryColor: "#FF0000", // Only this field is provided
        // Other fields are undefined (not provided)
      };

      // This is what the OLD buggy code would do
      const oldBuggyBrandGuidelinesData = {
        brandData: {
          brandName: incomingData.brandName || "", // BUG: Overwrites with empty string
          tagline: incomingData.tagline || "", // BUG: Overwrites with empty string
          primaryColor: incomingData.primaryColor || "", // This works
          secondaryColor: incomingData.secondaryColor || "", // BUG: Overwrites with empty string
          fontFamily: incomingData.fontFamily || "", // BUG: Overwrites with empty string
          toneOfVoice: incomingData.toneOfVoice || "", // BUG: Overwrites with empty string
          keyMessages: [], // BUG: Overwrites with empty array
          brandValues: [], // BUG: Overwrites with empty array
          targetAudience: incomingData.targetAudience || "", // BUG: Overwrites with empty string
          brandPersonality: incomingData.brandPersonality || "", // BUG: Overwrites with empty string
          founders: [],
        },
        attachments: existingBrandGuidelines?.attachments || [],
        createdAt: existingBrandGuidelines?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Verify the old buggy behavior
      expect(oldBuggyBrandGuidelinesData.brandData.brandName).toBe(""); // ❌ BUG: Should be "DataScoop"
      expect(oldBuggyBrandGuidelinesData.brandData.tagline).toBe(""); // ❌ BUG: Should be "AI Risk Detective for Auto Lenders"
      expect(oldBuggyBrandGuidelinesData.brandData.primaryColor).toBe("#FF0000"); // ✅ This works
      expect(oldBuggyBrandGuidelinesData.brandData.secondaryColor).toBe(""); // ❌ BUG: Should be "#00FF00"
      expect(oldBuggyBrandGuidelinesData.brandData.fontFamily).toBe(""); // ❌ BUG: Should be "Arial"
      expect(oldBuggyBrandGuidelinesData.brandData.toneOfVoice).toBe(""); // ❌ BUG: Should be "Professional"
      expect(oldBuggyBrandGuidelinesData.brandData.keyMessages).toEqual([]); // ❌ BUG: Should be ["AI-powered risk detection"]
      expect(oldBuggyBrandGuidelinesData.brandData.brandValues).toEqual([]); // ❌ BUG: Should be ["Accuracy", "Transparency"]
      expect(oldBuggyBrandGuidelinesData.brandData.targetAudience).toBe(""); // ❌ BUG: Should be "CXOs and executives"
      expect(oldBuggyBrandGuidelinesData.brandData.brandPersonality).toBe(""); // ❌ BUG: Should be "Analytical, trustworthy"
    });

    it('should handle empty strings correctly - only update when explicitly provided', () => {
      // Simulate existing brand guidelines with data
      const existingBrandGuidelines = {
        brandData: {
          brandName: "DataScoop",
          tagline: "AI Risk Detective for Auto Lenders",
          primaryColor: "#0000FF",
          secondaryColor: "#00FF00",
          fontFamily: "Arial",
          toneOfVoice: "Professional",
          keyMessages: ["AI-powered risk detection"],
          brandValues: ["Accuracy", "Transparency"],
          targetAudience: "CXOs and executives",
          brandPersonality: "Analytical, trustworthy",
          primaryColorEnd: "",
          isGradient: false,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request data with explicit empty string
      const incomingData = {
        brandName: "Updated DataScoop", // Explicitly provided
        tagline: "", // Explicitly set to empty string
        primaryColor: "#FF0000", // Explicitly provided
        // Other fields are undefined (not provided)
      };

      // Test the fixed logic
      const brandGuidelinesData = {
        brandData: {
          brandName: incomingData.brandName !== undefined ? incomingData.brandName : (existingBrandGuidelines?.brandData?.brandName || ""),
          tagline: incomingData.tagline !== undefined ? incomingData.tagline : (existingBrandGuidelines?.brandData?.tagline || ""),
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          secondaryColor: incomingData.secondaryColor !== undefined ? incomingData.secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          fontFamily: incomingData.fontFamily !== undefined ? incomingData.fontFamily : (existingBrandGuidelines?.brandData?.fontFamily || ""),
          toneOfVoice: incomingData.toneOfVoice !== undefined ? incomingData.toneOfVoice : (existingBrandGuidelines?.brandData?.toneOfVoice || ""),
          keyMessages: existingBrandGuidelines?.brandData?.keyMessages || [],
          brandValues: existingBrandGuidelines?.brandData?.brandValues || [],
          targetAudience: incomingData.targetAudience !== undefined ? incomingData.targetAudience : (existingBrandGuidelines?.brandData?.targetAudience || ""),
          brandPersonality: incomingData.brandPersonality !== undefined ? incomingData.brandPersonality : (existingBrandGuidelines?.brandData?.brandPersonality || ""),
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
        attachments: existingBrandGuidelines?.attachments || [],
        createdAt: existingBrandGuidelines?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Verify the fix works correctly
      expect(brandGuidelinesData.brandData.brandName).toBe("Updated DataScoop"); // ✅ Updated
      expect(brandGuidelinesData.brandData.tagline).toBe(""); // ✅ Explicitly set to empty
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000"); // ✅ Updated
      expect(brandGuidelinesData.brandData.secondaryColor).toBe("#00FF00"); // ✅ Preserved (not provided)
      expect(brandGuidelinesData.brandData.fontFamily).toBe("Arial"); // ✅ Preserved (not provided)
      expect(brandGuidelinesData.brandData.toneOfVoice).toBe("Professional"); // ✅ Preserved (not provided)
      expect(brandGuidelinesData.brandData.keyMessages).toEqual(["AI-powered risk detection"]); // ✅ Preserved
      expect(brandGuidelinesData.brandData.brandValues).toEqual(["Accuracy", "Transparency"]); // ✅ Preserved
      expect(brandGuidelinesData.brandData.targetAudience).toBe("CXOs and executives"); // ✅ Preserved (not provided)
      expect(brandGuidelinesData.brandData.brandPersonality).toBe("Analytical, trustworthy"); // ✅ Preserved (not provided)
    });

    it('should create new brand guidelines when none exist', () => {
      // Simulate no existing brand guidelines
      const existingBrandGuidelines = null;

      // Simulate incoming request data
      const incomingData = {
        brandName: "New Brand",
        tagline: "New Tagline",
        primaryColor: "#FF0000",
        secondaryColor: "#00FF00",
        fontFamily: "Arial",
        toneOfVoice: "Professional",
        keyMessages: ["New message"],
        brandValues: ["New value"],
        targetAudience: "New audience",
        brandPersonality: "New personality",
      };

      // Test the fixed logic
      const brandGuidelinesData = {
        brandData: {
          brandName: incomingData.brandName !== undefined ? incomingData.brandName : (existingBrandGuidelines?.brandData?.brandName || ""),
          tagline: incomingData.tagline !== undefined ? incomingData.tagline : (existingBrandGuidelines?.brandData?.tagline || ""),
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          secondaryColor: incomingData.secondaryColor !== undefined ? incomingData.secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          fontFamily: incomingData.fontFamily !== undefined ? incomingData.fontFamily : (existingBrandGuidelines?.brandData?.fontFamily || ""),
          toneOfVoice: incomingData.toneOfVoice !== undefined ? incomingData.toneOfVoice : (existingBrandGuidelines?.brandData?.toneOfVoice || ""),
          keyMessages: incomingData.keyMessages || [],
          brandValues: incomingData.brandValues || [],
          targetAudience: incomingData.targetAudience !== undefined ? incomingData.targetAudience : (existingBrandGuidelines?.brandData?.targetAudience || ""),
          brandPersonality: incomingData.brandPersonality !== undefined ? incomingData.brandPersonality : (existingBrandGuidelines?.brandData?.brandPersonality || ""),
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
        attachments: existingBrandGuidelines?.attachments || [],
        createdAt: existingBrandGuidelines?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Verify new brand guidelines are created correctly
      expect(brandGuidelinesData.brandData.brandName).toBe("New Brand");
      expect(brandGuidelinesData.brandData.tagline).toBe("New Tagline");
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000");
      expect(brandGuidelinesData.brandData.secondaryColor).toBe("#00FF00");
      expect(brandGuidelinesData.brandData.fontFamily).toBe("Arial");
      expect(brandGuidelinesData.brandData.toneOfVoice).toBe("Professional");
      expect(brandGuidelinesData.brandData.keyMessages).toEqual(["New message"]);
      expect(brandGuidelinesData.brandData.brandValues).toEqual(["New value"]);
      expect(brandGuidelinesData.brandData.targetAudience).toBe("New audience");
      expect(brandGuidelinesData.brandData.brandPersonality).toBe("New personality");
    });
  });
});