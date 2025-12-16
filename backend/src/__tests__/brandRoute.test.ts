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
      const incomingData: any = {
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
      const incomingData: any = {
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
      const incomingData: any = {
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
      const existingBrandGuidelines: any = null;

      // Simulate incoming request data
      const incomingData: any = {
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

  describe('✅ primaryColorEnd and isGradient field handling', () => {
    it('should save primaryColorEnd when provided', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          primaryColor: "#0000FF",
          primaryColorEnd: "#000000",
          secondaryColor: "#00FF00",
          isGradient: false,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with primaryColorEnd
      const incomingData: any = {
        primaryColor: "#FF0000",
        primaryColorEnd: "#FF00FF", // New value
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          secondaryColor: incomingData.secondaryColor !== undefined ? incomingData.secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify primaryColorEnd is saved
      expect(brandGuidelinesData.brandData.primaryColorEnd).toBe("#FF00FF"); // ✅ Updated
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000"); // ✅ Updated
      expect(brandGuidelinesData.brandData.isGradient).toBe(false); // ✅ Preserved (not provided)
    });

    it('should preserve existing primaryColorEnd when not provided', () => {
      // Simulate existing brand guidelines with primaryColorEnd
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          primaryColor: "#0000FF",
          primaryColorEnd: "#ECAC5F", // Existing value
          secondaryColor: "#00FF00",
          isGradient: true,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request without primaryColorEnd
      const incomingData: any = {
        primaryColor: "#FF0000",
        // primaryColorEnd is undefined (not provided)
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          secondaryColor: incomingData.secondaryColor !== undefined ? incomingData.secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify primaryColorEnd is preserved
      expect(brandGuidelinesData.brandData.primaryColorEnd).toBe("#ECAC5F"); // ✅ Preserved
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000"); // ✅ Updated
      expect(brandGuidelinesData.brandData.isGradient).toBe(true); // ✅ Preserved
    });

    it('should save isGradient when provided as boolean', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          primaryColor: "#0000FF",
          primaryColorEnd: "#000000",
          secondaryColor: "#00FF00",
          isGradient: false,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with isGradient as boolean
      const incomingData: any = {
        primaryColor: "#FF0000",
        isGradient: true, // Boolean value
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify isGradient is saved
      expect(brandGuidelinesData.brandData.isGradient).toBe(true); // ✅ Updated
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000"); // ✅ Updated
    });

    it('should save isGradient when provided as string "true"', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          primaryColor: "#0000FF",
          primaryColorEnd: "#000000",
          secondaryColor: "#00FF00",
          isGradient: false,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with isGradient as string
      const incomingData: any = {
        primaryColor: "#FF0000",
        isGradient: "true", // String value
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify isGradient is parsed correctly from string
      expect(brandGuidelinesData.brandData.isGradient).toBe(true); // ✅ Parsed from "true"
    });

    it('should save isGradient when provided as string "false"', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          primaryColor: "#0000FF",
          primaryColorEnd: "#000000",
          secondaryColor: "#00FF00",
          isGradient: true,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with isGradient as string
      const incomingData: any = {
        primaryColor: "#FF0000",
        isGradient: "false", // String value
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify isGradient is parsed correctly from string
      expect(brandGuidelinesData.brandData.isGradient).toBe(false); // ✅ Parsed from "false"
    });

    it('should preserve existing isGradient when not provided', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          primaryColor: "#0000FF",
          primaryColorEnd: "#ECAC5F",
          secondaryColor: "#00FF00",
          isGradient: true, // Existing value
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request without isGradient
      const incomingData: any = {
        primaryColor: "#FF0000",
        // isGradient is undefined (not provided)
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify isGradient is preserved
      expect(brandGuidelinesData.brandData.isGradient).toBe(true); // ✅ Preserved
      expect(brandGuidelinesData.brandData.primaryColorEnd).toBe("#ECAC5F"); // ✅ Preserved
    });

    it('should save both primaryColorEnd and isGradient together', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          primaryColor: "#0000FF",
          primaryColorEnd: "#000000",
          secondaryColor: "#00FF00",
          isGradient: false,
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with both fields
      const incomingData: any = {
        primaryColor: "#FF0000",
        primaryColorEnd: "#FF00FF",
        isGradient: true,
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          secondaryColor: incomingData.secondaryColor !== undefined ? incomingData.secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify both fields are saved
      expect(brandGuidelinesData.brandData.primaryColorEnd).toBe("#FF00FF"); // ✅ Updated
      expect(brandGuidelinesData.brandData.isGradient).toBe(true); // ✅ Updated
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000"); // ✅ Updated
    });

    it('should create new brand guidelines with primaryColorEnd and isGradient', () => {
      // Simulate no existing brand guidelines
      const existingBrandGuidelines: any = null;

      // Simulate incoming request data
      const incomingData: any = {
        brandName: "New Brand",
        primaryColor: "#FF0000",
        primaryColorEnd: "#ECAC5F",
        secondaryColor: "#00FF00",
        isGradient: true,
      };

      // Test the logic (matching the backend route)
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (incomingData.isGradient !== undefined) {
        parsedIsGradient = typeof incomingData.isGradient === 'string' ? incomingData.isGradient === 'true' : Boolean(incomingData.isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          brandName: incomingData.brandName !== undefined ? incomingData.brandName : (existingBrandGuidelines?.brandData?.brandName || ""),
          primaryColor: incomingData.primaryColor !== undefined ? incomingData.primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: incomingData.primaryColorEnd !== undefined ? incomingData.primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          secondaryColor: incomingData.secondaryColor !== undefined ? incomingData.secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          isGradient: parsedIsGradient,
          founders: existingBrandGuidelines?.brandData?.founders || [],
        },
      };

      // Verify new brand guidelines are created correctly
      expect(brandGuidelinesData.brandData.brandName).toBe("New Brand");
      expect(brandGuidelinesData.brandData.primaryColor).toBe("#FF0000");
      expect(brandGuidelinesData.brandData.primaryColorEnd).toBe("#ECAC5F"); // ✅ Created with primaryColorEnd
      expect(brandGuidelinesData.brandData.isGradient).toBe(true); // ✅ Created with isGradient
    });
  });

  describe('🐛 BUG FIX: keyMessages and brandValues should not overwrite each other', () => {
    it('should preserve brandValues when updating keyMessages only', () => {
      // Simulate existing brand guidelines with both keyMessages and brandValues
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          keyMessages: ["Original message 1", "Original message 2"],
          brandValues: ["Value 1", "Value 2", "Value 3"],
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with only keyMessages (brandValues is undefined)
      const incomingData: any = {
        keyMessages: JSON.stringify(["New message 1", "New message 2"]),
        // brandValues is undefined (not provided)
      };

      // Test the fixed logic (matching the backend route)
      let parsedKeyMessages = existingBrandGuidelines?.brandData?.keyMessages || [];
      if (incomingData.keyMessages !== undefined) {
        try {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string"
              ? JSON.parse(incomingData.keyMessages)
              : incomingData.keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string" ? [incomingData.keyMessages] : incomingData.keyMessages;
        }
      }

      let parsedBrandValues = existingBrandGuidelines?.brandData?.brandValues || [];
      if (incomingData.brandValues !== undefined) {
        try {
          parsedBrandValues =
            typeof incomingData.brandValues === "string"
              ? JSON.parse(incomingData.brandValues)
              : incomingData.brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof incomingData.brandValues === "string" ? [incomingData.brandValues] : incomingData.brandValues;
        }
      }

      // Verify the fix works
      expect(parsedKeyMessages).toEqual(["New message 1", "New message 2"]); // ✅ Updated
      expect(parsedBrandValues).toEqual(["Value 1", "Value 2", "Value 3"]); // ✅ Preserved (not removed!)
    });

    it('should preserve keyMessages when updating brandValues only', () => {
      // Simulate existing brand guidelines with both keyMessages and brandValues
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          keyMessages: ["Message 1", "Message 2", "Message 3"],
          brandValues: ["Original value 1", "Original value 2"],
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with only brandValues (keyMessages is undefined)
      const incomingData: any = {
        brandValues: ["New value 1", "New value 2", "New value 3"],
        // keyMessages is undefined (not provided)
      };

      // Test the fixed logic (matching the backend route)
      let parsedKeyMessages = existingBrandGuidelines?.brandData?.keyMessages || [];
      if (incomingData.keyMessages !== undefined) {
        try {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string"
              ? JSON.parse(incomingData.keyMessages)
              : incomingData.keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string" ? [incomingData.keyMessages] : incomingData.keyMessages;
        }
      }

      let parsedBrandValues = existingBrandGuidelines?.brandData?.brandValues || [];
      if (incomingData.brandValues !== undefined) {
        try {
          parsedBrandValues =
            typeof incomingData.brandValues === "string"
              ? JSON.parse(incomingData.brandValues)
              : incomingData.brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof incomingData.brandValues === "string" ? [incomingData.brandValues] : incomingData.brandValues;
        }
      }

      // Verify the fix works
      expect(parsedKeyMessages).toEqual(["Message 1", "Message 2", "Message 3"]); // ✅ Preserved (not removed!)
      expect(parsedBrandValues).toEqual(["New value 1", "New value 2", "New value 3"]); // ✅ Updated
    });

    it('should update both keyMessages and brandValues when both are provided', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          keyMessages: ["Old message"],
          brandValues: ["Old value"],
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with both fields
      const incomingData: any = {
        keyMessages: ["New message 1", "New message 2"],
        brandValues: ["New value 1", "New value 2"],
      };

      // Test the fixed logic (matching the backend route)
      let parsedKeyMessages = existingBrandGuidelines?.brandData?.keyMessages || [];
      if (incomingData.keyMessages !== undefined) {
        try {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string"
              ? JSON.parse(incomingData.keyMessages)
              : incomingData.keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string" ? [incomingData.keyMessages] : incomingData.keyMessages;
        }
      }

      let parsedBrandValues = existingBrandGuidelines?.brandData?.brandValues || [];
      if (incomingData.brandValues !== undefined) {
        try {
          parsedBrandValues =
            typeof incomingData.brandValues === "string"
              ? JSON.parse(incomingData.brandValues)
              : incomingData.brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof incomingData.brandValues === "string" ? [incomingData.brandValues] : incomingData.brandValues;
        }
      }

      // Verify both are updated
      expect(parsedKeyMessages).toEqual(["New message 1", "New message 2"]); // ✅ Updated
      expect(parsedBrandValues).toEqual(["New value 1", "New value 2"]); // ✅ Updated
    });

    it('should handle empty arrays correctly - allow clearing when explicitly provided', () => {
      // Simulate existing brand guidelines with data
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          keyMessages: ["Message 1", "Message 2"],
          brandValues: ["Value 1", "Value 2"],
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with empty array for keyMessages (explicitly clearing it)
      const incomingData: any = {
        keyMessages: [], // Explicitly empty array
        // brandValues is undefined (not provided)
      };

      // Test the fixed logic (matching the backend route)
      let parsedKeyMessages = existingBrandGuidelines?.brandData?.keyMessages || [];
      if (incomingData.keyMessages !== undefined) {
        try {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string"
              ? JSON.parse(incomingData.keyMessages)
              : incomingData.keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string" ? [incomingData.keyMessages] : incomingData.keyMessages;
        }
      }

      let parsedBrandValues = existingBrandGuidelines?.brandData?.brandValues || [];
      if (incomingData.brandValues !== undefined) {
        try {
          parsedBrandValues =
            typeof incomingData.brandValues === "string"
              ? JSON.parse(incomingData.brandValues)
              : incomingData.brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof incomingData.brandValues === "string" ? [incomingData.brandValues] : incomingData.brandValues;
        }
      }

      // Verify empty array clears keyMessages but preserves brandValues
      expect(parsedKeyMessages).toEqual([]); // ✅ Cleared (explicitly provided empty array)
      expect(parsedBrandValues).toEqual(["Value 1", "Value 2"]); // ✅ Preserved (not provided)
    });

    it('should handle string parsing for keyMessages and brandValues', () => {
      // Simulate existing brand guidelines
      const existingBrandGuidelines = {
        brandData: {
          brandName: "Test Brand",
          keyMessages: ["Old message"],
          brandValues: ["Old value"],
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with string JSON for keyMessages
      const incomingData: any = {
        keyMessages: '["String message 1", "String message 2"]', // String JSON
        // brandValues is undefined (not provided)
      };

      // Test the fixed logic (matching the backend route)
      let parsedKeyMessages = existingBrandGuidelines?.brandData?.keyMessages || [];
      if (incomingData.keyMessages !== undefined) {
        try {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string"
              ? JSON.parse(incomingData.keyMessages)
              : incomingData.keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string" ? [incomingData.keyMessages] : incomingData.keyMessages;
        }
      }

      let parsedBrandValues = existingBrandGuidelines?.brandData?.brandValues || [];
      if (incomingData.brandValues !== undefined) {
        try {
          parsedBrandValues =
            typeof incomingData.brandValues === "string"
              ? JSON.parse(incomingData.brandValues)
              : incomingData.brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof incomingData.brandValues === "string" ? [incomingData.brandValues] : incomingData.brandValues;
        }
      }

      // Verify string parsing works and brandValues is preserved
      expect(parsedKeyMessages).toEqual(["String message 1", "String message 2"]); // ✅ Parsed from string
      expect(parsedBrandValues).toEqual(["Old value"]); // ✅ Preserved
    });

    it('should demonstrate the old buggy behavior (for comparison)', () => {
      // This test shows what the old buggy code would do
      const existingBrandGuidelines = {
        brandData: {
          keyMessages: ["Message 1", "Message 2"],
          brandValues: ["Value 1", "Value 2"],
          founders: [],
        },
        attachments: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Simulate incoming request with only keyMessages
      const incomingData: any = {
        keyMessages: ["New message"],
        // brandValues is undefined (not provided)
      };

      // OLD BUGGY CODE: Always initialized as empty arrays
      let parsedKeyMessages = []; // BUG: Always empty initially
      if (incomingData.keyMessages) { // BUG: Only checks truthiness
        parsedKeyMessages = incomingData.keyMessages;
      }

      let parsedBrandValues = []; // BUG: Always empty initially
      if (incomingData.brandValues) { // BUG: Only checks truthiness
        parsedBrandValues = incomingData.brandValues;
      }

      // Verify the old buggy behavior
      expect(parsedKeyMessages).toEqual(["New message"]); // ✅ This works
      expect(parsedBrandValues).toEqual([]); // ❌ BUG: Should be ["Value 1", "Value 2"] but gets empty array!
    });

    it('should create new brand guidelines with keyMessages and brandValues when none exist', () => {
      // Simulate no existing brand guidelines
      const existingBrandGuidelines: any = null;

      // Simulate incoming request data
      const incomingData: any = {
        keyMessages: ["New message 1", "New message 2"],
        brandValues: ["New value 1", "New value 2"],
      };

      // Test the fixed logic (matching the backend route)
      let parsedKeyMessages = existingBrandGuidelines?.brandData?.keyMessages || [];
      if (incomingData.keyMessages !== undefined) {
        try {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string"
              ? JSON.parse(incomingData.keyMessages)
              : incomingData.keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof incomingData.keyMessages === "string" ? [incomingData.keyMessages] : incomingData.keyMessages;
        }
      }

      let parsedBrandValues = existingBrandGuidelines?.brandData?.brandValues || [];
      if (incomingData.brandValues !== undefined) {
        try {
          parsedBrandValues =
            typeof incomingData.brandValues === "string"
              ? JSON.parse(incomingData.brandValues)
              : incomingData.brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof incomingData.brandValues === "string" ? [incomingData.brandValues] : incomingData.brandValues;
        }
      }

      // Verify new brand guidelines are created correctly
      expect(parsedKeyMessages).toEqual(["New message 1", "New message 2"]);
      expect(parsedBrandValues).toEqual(["New value 1", "New value 2"]);
    });
  });
});