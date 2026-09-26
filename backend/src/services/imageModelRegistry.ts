export const IMAGE_MODEL_IDS = [
  "gpt-image-1",
  "gpt-image-2",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image",
  // Legacy preview id — accepted as an alias of gemini-3.1-flash-image so that
  // persisted settings, in-flight sessions, and scheduled chats created before
  // the GA migration keep working. Normalized to the GA id before dispatch.
  "gemini-3.1-flash-image-preview",
  "gen4_image",
  "gemini_2.5_flash",
] as const;
