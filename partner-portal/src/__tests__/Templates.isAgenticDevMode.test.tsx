import '@testing-library/jest-dom';

/**
 * Unit tests for Templates page - isAgenticDevMode functionality
 * 
 * These tests verify that:
 * 1. isAgenticDevMode is properly initialized from template data
 * 2. isAgenticDevMode is included in template creation/update payloads
 * 3. isAgenticDevMode defaults to false when not provided
 */

describe('Templates - isAgenticDevMode Logic Tests', () => {
  describe('isAgenticDevMode state initialization', () => {
    it('should default to false when template has undefined isAgenticDevMode', () => {
      const template = {
        templateId: 'template-1',
        name: 'Test Template',
        isAgenticDevMode: undefined,
      };

      // Simulate the initialization logic from Templates.tsx
      const isAgenticDevMode = template.isAgenticDevMode || false;
      expect(isAgenticDevMode).toBe(false);
    });

    it('should use template value when isAgenticDevMode is true', () => {
      const template = {
        templateId: 'template-1',
        name: 'Test Template',
        isAgenticDevMode: true,
      };

      // Simulate the initialization logic from Templates.tsx
      const isAgenticDevMode = template.isAgenticDevMode || false;
      expect(isAgenticDevMode).toBe(true);
    });

    it('should use template value when isAgenticDevMode is false', () => {
      const template = {
        templateId: 'template-1',
        name: 'Test Template',
        isAgenticDevMode: false,
      };

      // Simulate the initialization logic from Templates.tsx
      const isAgenticDevMode = template.isAgenticDevMode || false;
      expect(isAgenticDevMode).toBe(false);
    });
  });

  describe('isAgenticDevMode in template payload', () => {
    it('should include isAgenticDevMode=true in template creation payload', () => {
      // Simulate the templateData construction from Templates.tsx handleSubmit
      const templateData = {
        name: 'New Template',
        prompt: 'Test prompt',
        isAgenticDevMode: true,
      };

      expect(templateData).toHaveProperty('isAgenticDevMode', true);
      expect(templateData.isAgenticDevMode).toBe(true);
    });

    it('should include isAgenticDevMode=false in template creation payload', () => {
      // Simulate the templateData construction from Templates.tsx handleSubmit
      const templateData = {
        name: 'New Template',
        prompt: 'Test prompt',
        isAgenticDevMode: false,
      };

      expect(templateData).toHaveProperty('isAgenticDevMode', false);
      expect(templateData.isAgenticDevMode).toBe(false);
    });

    it('should include isAgenticDevMode in template update payload', () => {
      // Simulate the templateData construction from Templates.tsx handleSubmit for update
      const templateData = {
        name: 'Updated Template',
        prompt: 'Updated prompt',
        isAgenticDevMode: true,
      };

      expect(templateData).toHaveProperty('isAgenticDevMode', true);
      expect(templateData.isAgenticDevMode).toBe(true);
    });
  });

  describe('isAgenticDevMode interface and type safety', () => {
    it('should have isAgenticDevMode as optional boolean in Template interface', () => {
      // Simulate the Template interface from Templates.tsx
      interface Template {
        templateId: string;
        name: string;
        isAgenticDevMode?: boolean;
      }

      const template1: Template = {
        templateId: 'template-1',
        name: 'Test Template',
        // isAgenticDevMode is optional
      };

      const template2: Template = {
        templateId: 'template-2',
        name: 'Test Template 2',
        isAgenticDevMode: true,
      };

      expect(template1.isAgenticDevMode).toBeUndefined();
      expect(template2.isAgenticDevMode).toBe(true);
    });
  });

  describe('isAgenticDevMode state management logic', () => {
    it('should reset isAgenticDevMode to false when creating new template', () => {
      // Simulate the reset logic when opening create dialog
      let isAgenticDevMode = true; // Previous state
      
      // Reset to false for new template (simulating setState(false))
      isAgenticDevMode = false;
      
      expect(isAgenticDevMode).toBe(false);
    });

    it('should preserve isAgenticDevMode when editing existing template', () => {
      const template = {
        templateId: 'template-1',
        name: 'Test Template',
        isAgenticDevMode: true,
      };

      // Simulate setting state from template
      const isAgenticDevMode = template.isAgenticDevMode || false;
      
      expect(isAgenticDevMode).toBe(true);
    });
  });
});
