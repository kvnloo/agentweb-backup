/**
 * Tests for SSE progress utility functions
 */

import {
  emitProgress,
  registerProgressCallback,
  getLatestProgress,
  cleanupProgress,
  progressStore,
  emitActionIntent,
  getActionIntentsForTools
} from '../sseProgress';

describe('SSE Progress Utility', () => {
  const sessionId = 'test-session-123';
  const mockProgress = {
    iteration: 1,
    status: 'thinking',
    toolCalls: [],
    pendingTools: []
  };

  beforeEach(() => {
    // Clear all progress data before each test
    cleanupProgress(sessionId);
    progressStore.clear();
  });

  afterEach(() => {
    // Clean up after each test
    cleanupProgress(sessionId);
    progressStore.clear();
  });

  describe('emitProgress', () => {
    it('should store progress in the progress store', () => {
      emitProgress(sessionId, mockProgress);

      const stored = getLatestProgress(sessionId);
      expect(stored).toEqual(mockProgress);
    });

    it('should notify registered callbacks', () => {
      const callback = jest.fn();
      registerProgressCallback(sessionId, callback);

      emitProgress(sessionId, mockProgress);

      expect(callback).toHaveBeenCalledWith(mockProgress);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should notify multiple callbacks for the same session', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      
      registerProgressCallback(sessionId, callback1);
      registerProgressCallback(sessionId, callback2);

      emitProgress(sessionId, mockProgress);

      expect(callback1).toHaveBeenCalledWith(mockProgress);
      expect(callback2).toHaveBeenCalledWith(mockProgress);
    });

    it('should handle errors in callbacks gracefully', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const callback = jest.fn(() => {
        throw new Error('Callback error');
      });

      registerProgressCallback(sessionId, callback);

      // Should not throw
      expect(() => emitProgress(sessionId, mockProgress)).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should silently handle progress when no active connections exist', () => {
      // Emit progress without any registered callbacks
      // Should not throw and should still store progress
      emitProgress(sessionId, mockProgress);

      // Progress should still be stored even without active connections
      const stored = getLatestProgress(sessionId);
      expect(stored).toEqual(mockProgress);
    });

    it('should update progress store with latest progress', () => {
      const progress1 = { ...mockProgress, iteration: 1, status: 'thinking' };
      const progress2 = { ...mockProgress, iteration: 2, status: 'executing_tools' };

      emitProgress(sessionId, progress1);
      expect(getLatestProgress(sessionId)).toEqual(progress1);

      emitProgress(sessionId, progress2);
      expect(getLatestProgress(sessionId)).toEqual(progress2);
    });
  });

  describe('registerProgressCallback', () => {
    it('should register a callback and return cleanup function', () => {
      const callback = jest.fn();
      const cleanup = registerProgressCallback(sessionId, callback);

      expect(cleanup).toBeInstanceOf(Function);

      emitProgress(sessionId, mockProgress);
      expect(callback).toHaveBeenCalled();

      // Cleanup
      cleanup();
      emitProgress(sessionId, mockProgress);
      // Should not be called again after cleanup
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should allow multiple callbacks for the same session', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      registerProgressCallback(sessionId, callback1);
      registerProgressCallback(sessionId, callback2);

      emitProgress(sessionId, mockProgress);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should keep progress store when last callback is removed', () => {
      const callback = jest.fn();
      const cleanup = registerProgressCallback(sessionId, callback);

      emitProgress(sessionId, mockProgress);
      expect(getLatestProgress(sessionId)).toBeDefined();

      cleanup();
      // Progress should remain available for reconnecting clients
      expect(getLatestProgress(sessionId)).toBeDefined();
    });

    it('should preserve progress after cleanup for later reads', () => {
      const callback = jest.fn();
      const cleanup = registerProgressCallback(sessionId, callback);

      emitProgress(sessionId, mockProgress);
      cleanup();

      const stored = getLatestProgress(sessionId);
      expect(stored).toEqual(mockProgress);
    });
  });

  describe('getLatestProgress', () => {
    it('should return undefined for non-existent session', () => {
      expect(getLatestProgress('non-existent-session')).toBeUndefined();
    });

    it('should return the latest progress for a session', () => {
      emitProgress(sessionId, mockProgress);
      expect(getLatestProgress(sessionId)).toEqual(mockProgress);
    });

    it('should return updated progress after multiple emissions', () => {
      const progress1 = { ...mockProgress, iteration: 1 };
      const progress2 = { ...mockProgress, iteration: 2 };

      emitProgress(sessionId, progress1);
      expect(getLatestProgress(sessionId)).toEqual(progress1);

      emitProgress(sessionId, progress2);
      expect(getLatestProgress(sessionId)).toEqual(progress2);
    });
  });

  describe('cleanupProgress', () => {
    it('should remove all callbacks and progress for a session', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      registerProgressCallback(sessionId, callback1);
      registerProgressCallback(sessionId, callback2);
      
      // Emit progress before cleanup - callbacks should be called
      emitProgress(sessionId, mockProgress);
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      cleanupProgress(sessionId);

      // Progress should be cleared immediately after cleanup
      expect(getLatestProgress(sessionId)).toBeUndefined();

      // Clear mock call history to check calls after cleanup
      callback1.mockClear();
      callback2.mockClear();

      // Callbacks should not be called after cleanup
      emitProgress(sessionId, mockProgress);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should handle cleanup for non-existent session', () => {
      expect(() => cleanupProgress('non-existent-session')).not.toThrow();
    });
  });

  describe('Progress with pendingTools', () => {
    it('should handle progress with pendingTools', () => {
      const progressWithTools = {
        iteration: 1,
        status: 'executing_tools',
        toolCalls: [],
        pendingTools: ['create_task_from_template', 'search_knowledge_base']
      };

      const callback = jest.fn();
      registerProgressCallback(sessionId, callback);

      emitProgress(sessionId, progressWithTools);

      expect(callback).toHaveBeenCalledWith(progressWithTools);
      expect(getLatestProgress(sessionId)?.pendingTools).toEqual(['create_task_from_template', 'search_knowledge_base']);
    });
  });

  describe('Action intents', () => {
    it('should pass through progress with actions array to callbacks', () => {
      const progressWithActions = {
        iteration: 1,
        status: 'tool_executed',
        toolCalls: [],
        actions: [
          { type: 'navigate' as const, route: '/brand-guidelines', label: 'View Brand Guidelines' }
        ]
      };

      const callback = jest.fn();
      registerProgressCallback(sessionId, callback);

      emitProgress(sessionId, progressWithActions);

      expect(callback).toHaveBeenCalledWith(progressWithActions);
      const stored = getLatestProgress(sessionId);
      expect(stored?.actions).toHaveLength(1);
      expect(stored?.actions?.[0]).toEqual({
        type: 'navigate',
        route: '/brand-guidelines',
        label: 'View Brand Guidelines'
      });
    });

    it('should preserve backward compatibility when no actions field is present', () => {
      const progressWithoutActions = {
        iteration: 1,
        status: 'tool_executed',
        toolCalls: []
      };

      const callback = jest.fn();
      registerProgressCallback(sessionId, callback);

      emitProgress(sessionId, progressWithoutActions);

      expect(callback).toHaveBeenCalledWith(progressWithoutActions);
      const stored = getLatestProgress(sessionId);
      expect(stored?.actions).toBeUndefined();
    });

    it('should support multiple actions in a single progress update', () => {
      const progressWithMultipleActions = {
        iteration: 1,
        status: 'tool_executed',
        toolCalls: [],
        actions: [
          { type: 'navigate' as const, route: '/brand-guidelines', label: 'View Brand Guidelines' },
          { type: 'highlight' as const, elementId: 'brand-logo', label: 'Brand Logo Updated' }
        ]
      };

      const callback = jest.fn();
      registerProgressCallback(sessionId, callback);

      emitProgress(sessionId, progressWithMultipleActions);

      const stored = getLatestProgress(sessionId);
      expect(stored?.actions).toHaveLength(2);
      expect(stored?.actions?.[0].type).toBe('navigate');
      expect(stored?.actions?.[1].type).toBe('highlight');
    });
  });

  describe('emitActionIntent', () => {
    it('should emit a navigation action intent for a session', () => {
      const callback = jest.fn();
      registerProgressCallback(sessionId, callback);

      emitActionIntent(sessionId, 1, 'navigate', '/brand-guidelines', 'View Brand Guidelines');

      expect(callback).toHaveBeenCalledTimes(1);
      const emittedProgress = callback.mock.calls[0][0];
      expect(emittedProgress.status).toBe('action_intent');
      expect(emittedProgress.iteration).toBe(1);
      expect(emittedProgress.actions).toHaveLength(1);
      expect(emittedProgress.actions[0]).toEqual({
        type: 'navigate',
        route: '/brand-guidelines',
        label: 'View Brand Guidelines'
      });
    });

    it('should emit a highlight action intent', () => {
      const callback = jest.fn();
      registerProgressCallback(sessionId, callback);

      emitActionIntent(sessionId, 2, 'highlight', 'brand-logo', 'Logo Updated');

      const emittedProgress = callback.mock.calls[0][0];
      expect(emittedProgress.actions[0]).toEqual({
        type: 'highlight',
        elementId: 'brand-logo',
        label: 'Logo Updated'
      });
    });
  });

  describe('getActionIntentsForTools', () => {
    it('should return navigation action for update_brand_guidelines', () => {
      const actions = getActionIntentsForTools(['update_brand_guidelines']);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual({
        type: 'navigate',
        route: '/brand-guidelines',
        label: 'View Brand Guidelines'
      });
    });

    it('should return navigation action for update_market_strategy', () => {
      const actions = getActionIntentsForTools(['update_market_strategy']);
      expect(actions).toHaveLength(1);
      expect(actions[0].route).toBe('/gtm-tracker');
    });

    it('should return navigation action for manage_crm_leads', () => {
      const actions = getActionIntentsForTools(['manage_crm_leads']);
      expect(actions).toHaveLength(1);
      expect(actions[0].route).toBe('/crm');
    });

    it('should return navigation action for create_email_template', () => {
      const actions = getActionIntentsForTools(['create_email_template']);
      expect(actions).toHaveLength(1);
      expect(actions[0].route).toBe('/email-templates');
    });

    it('should return navigation action for create_landing_page', () => {
      const actions = getActionIntentsForTools(['create_landing_page']);
      expect(actions).toHaveLength(1);
      expect(actions[0].route).toBe('/landing-pages');
    });

    it('should return empty array for tools without navigation mapping', () => {
      const actions = getActionIntentsForTools(['search_knowledge_base']);
      expect(actions).toHaveLength(0);
    });

    it('should return multiple actions for multiple mapped tools', () => {
      const actions = getActionIntentsForTools(['update_brand_guidelines', 'manage_crm_leads']);
      expect(actions).toHaveLength(2);
      expect(actions[0].route).toBe('/brand-guidelines');
      expect(actions[1].route).toBe('/crm');
    });

    it('should deduplicate actions for the same route', () => {
      const actions = getActionIntentsForTools(['update_brand_guidelines', 'update_brand_guidelines']);
      expect(actions).toHaveLength(1);
    });

    it('should handle empty tool list', () => {
      const actions = getActionIntentsForTools([]);
      expect(actions).toHaveLength(0);
    });
  });
});
