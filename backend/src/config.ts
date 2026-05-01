// Configuration constants

// Maximum number of messages allowed per chat session.
// See dev.md "Message Limit & Context Window Investigation (2026-03-19)" for planned changes.
export const MAX_MESSAGE_SIZE_PER_SESSION = 500;

// Maximum file size for uploads (100MB in bytes)
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

// AI Model Configuration
export const DEEP_RESEARCH_AGENT = 'deep-research-pro-preview-12-2025';
export const CONTENT_RESTYLE_MODEL = 'gemini-3-flash-preview';

// Resend System Email Configuration
// This is used for all system-generated emails (notifications, announcements, etc.)
export const RESEND_SYSTEM_EMAIL = 'hi@updates.agentweb.pro';
export const RESEND_SYSTEM_NAME = 'AgentWeb';

// Emma Email Configuration
// Used for inbound/outbound Emma chatbot emails
export const EMMA_EMAIL_ADDRESS = 'emma@updates.agentweb.pro';
export const EMMA_EMAIL_FROM = 'Emma at AgentWeb <emma@updates.agentweb.pro>';

// Temp Email Configuration
// Used by Emma to receive test emails during automated tasks
export const TEMP_EMAIL_DOMAIN = 'updates.agentweb.pro';
export const TEMP_EMAIL_PREFIX = 'test';
