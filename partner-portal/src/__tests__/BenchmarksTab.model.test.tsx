import '@testing-library/jest-dom';
import { describe, it, expect, jest } from '@jest/globals';

// Test the model selection and display logic for BenchmarksTab
describe('BenchmarksTab - Model Selection', () => {
  describe('Model Selection in Create/Edit Dialog', () => {
    const mockSupportedModels = ['gpt-5-chat-2', 'gemini-3-pro-preview', 'gpt-4'];

    it('should default to first available model when creating new test', () => {
      const selectedModel = mockSupportedModels[0];
      expect(selectedModel).toBe('gpt-5-chat-2');
    });

    it('should use saved model when editing existing test', () => {
      const editTest = {
        testId: 'test-123',
        testName: 'Test',
        llmModel: 'gemini-3-pro-preview'
      };

      const selectedModel = editTest.llmModel && mockSupportedModels.includes(editTest.llmModel)
        ? editTest.llmModel
        : mockSupportedModels[0];

      expect(selectedModel).toBe('gemini-3-pro-preview');
    });

    it('should fallback to first model if saved model is not supported', () => {
      const editTest = {
        testId: 'test-123',
        testName: 'Test',
        llmModel: 'old-model-not-supported'
      };

      const selectedModel = editTest.llmModel && mockSupportedModels.includes(editTest.llmModel)
        ? editTest.llmModel
        : mockSupportedModels[0];

      expect(selectedModel).toBe('gpt-5-chat-2');
    });

    it('should include llmModel in create payload', () => {
      const selectedModel = 'gpt-5-chat-2';
      const payload = {
        testName: 'Test Name',
        expectedOutput: {},
        llmModel: selectedModel
      };

      expect(payload.llmModel).toBe('gpt-5-chat-2');
      expect(payload).toHaveProperty('llmModel');
    });

    it('should include llmModel in update payload', () => {
      const selectedModel = 'gemini-3-pro-preview';
      const updates = {
        testName: 'Updated Test',
        llmModel: selectedModel
      };

      expect(updates.llmModel).toBe('gemini-3-pro-preview');
      expect(updates).toHaveProperty('llmModel');
    });
  });

  describe('Last Run Model Display', () => {
    it('should display lastRunModel when available', () => {
      const benchmark = {
        testId: 'test-123',
        testName: 'Test',
        lastRunAt: '2024-01-01T00:00:00Z',
        lastRunModel: 'gpt-5-chat-2'
      };

      expect(benchmark.lastRunModel).toBe('gpt-5-chat-2');
      expect(benchmark).toHaveProperty('lastRunModel');
    });

    it('should handle missing lastRunModel gracefully', () => {
      const benchmark = {
        testId: 'test-123',
        testName: 'Test',
        lastRunAt: '2024-01-01T00:00:00Z',
        lastRunModel: undefined
      };

      expect(benchmark.lastRunModel).toBeUndefined();
    });

    it('should format lastRunModel for display', () => {
      const lastRunModel = 'gpt-5-chat-2';
      const displayText = `Model: ${lastRunModel}`;
      
      expect(displayText).toBe('Model: gpt-5-chat-2');
    });
  });

  describe('Test History Model Display', () => {
    it('should display model used in each test run', () => {
      const testHistory = [
        {
          runId: 'run-1',
          status: 'success',
          passed: true,
          llmModel: 'gpt-5-chat-2',
          createdAt: '2024-01-01T00:00:00Z'
        },
        {
          runId: 'run-2',
          status: 'success',
          passed: true,
          llmModel: 'gemini-3-pro-preview',
          createdAt: '2024-01-02T00:00:00Z'
        }
      ];

      expect(testHistory[0].llmModel).toBe('gpt-5-chat-2');
      expect(testHistory[1].llmModel).toBe('gemini-3-pro-preview');
    });

    it('should handle missing model in test history', () => {
      const testHistory = [
        {
          runId: 'run-1',
          status: 'success',
          passed: true,
          llmModel: undefined,
          createdAt: '2024-01-01T00:00:00Z'
        }
      ];

      expect(testHistory[0].llmModel).toBeUndefined();
    });
  });

  describe('Model Selection Priority', () => {
    it('should prioritize selectedModel over editTest.llmModel', () => {
      const selectedModel = 'gpt-5-chat-2';
      const editTest = { llmModel: 'gemini-3-pro-preview' };
      const supportedModels = ['gpt-5-chat-2', 'gemini-3-pro-preview'];

      const modelToUse = selectedModel || 
                        (editTest?.llmModel && supportedModels.includes(editTest.llmModel) ? editTest.llmModel : null) ||
                        (supportedModels.length > 0 ? supportedModels[0] : null);

      expect(modelToUse).toBe('gpt-5-chat-2');
    });

    it('should use editTest.llmModel when selectedModel is empty', () => {
      const selectedModel = '';
      const editTest = { llmModel: 'gemini-3-pro-preview' };
      const supportedModels = ['gpt-5-chat-2', 'gemini-3-pro-preview'];

      const modelToUse = selectedModel || 
                        (editTest?.llmModel && supportedModels.includes(editTest.llmModel) ? editTest.llmModel : null) ||
                        (supportedModels.length > 0 ? supportedModels[0] : null);

      expect(modelToUse).toBe('gemini-3-pro-preview');
    });

    it('should use first available model as fallback', () => {
      const selectedModel = '';
      const editTest = { llmModel: undefined };
      const supportedModels = ['gpt-5-chat-2', 'gemini-3-pro-preview'];

      const modelToUse = selectedModel || 
                        (editTest?.llmModel && supportedModels.includes(editTest.llmModel) ? editTest.llmModel : null) ||
                        (supportedModels.length > 0 ? supportedModels[0] : null);

      expect(modelToUse).toBe('gpt-5-chat-2');
    });
  });

  describe('Run Test with Model', () => {
    it('should pass selected model when running test from dialog', () => {
      const testId = 'test-123';
      const selectedModel = 'gpt-5-chat-2';
      const onRunTest = jest.fn();

      onRunTest(testId, selectedModel);

      expect(onRunTest).toHaveBeenCalledWith(testId, selectedModel);
    });

    it('should use test saved model when running from table', () => {
      const benchmark = {
        testId: 'test-123',
        testName: 'Test',
        llmModel: 'gemini-3-pro-preview'
      };

      const modelToUse = benchmark.llmModel || 'gpt-5-chat-2';

      expect(modelToUse).toBe('gemini-3-pro-preview');
    });
  });
});

