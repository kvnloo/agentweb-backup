/**
 * Handlers Index
 * 
 * Exports handler-related utilities.
 * 
 * NOTE: Handler configs are now derived from tool definitions.
 * Use DERIVED_HANDLER_CONFIGS from '../definitions' for the handler configs.
 */

// Export special handlers (still needed for complex tool logic)
export * from './specialHandlers';

// Re-export allHandlerConfigs for backward compatibility
// This is the ONLY handler config export needed - it's derived from definitions
import { DERIVED_HANDLER_CONFIGS } from '../definitions';
export const allHandlerConfigs = DERIVED_HANDLER_CONFIGS;
