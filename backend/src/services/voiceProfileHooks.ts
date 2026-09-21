/**
 * H-VOICE wiring: capture edits on publish + prompt injection helpers.
 */

import { chatbotDb } from './chatbotService';
import {
  appendVoiceObservation,
  formatVoiceCardPromptBlock,
  shouldCaptureVoiceEdit,
  summarizeVoiceEdit,
  type SessionVoiceProfile,
} from './voiceProfileService';

export async function captureVoiceEditOnPublish(params: {
  sessionId?: string;
  platform: string;
  draftContent?: string;
  approvedContent: string;
  existingProfile?: SessionVoiceProfile;
}): Promise<SessionVoiceProfile | null> {
  const { sessionId, platform, draftContent, approvedContent, existingProfile } = params;
  if (!sessionId) return null;
  if (!shouldCaptureVoiceEdit(draftContent, approvedContent)) return null;

  const summary = summarizeVoiceEdit(draftContent ?? '', approvedContent);
  const profile = appendVoiceObservation(existingProfile, {
    platform,
    summary,
    approvedSnippet: approvedContent.split('\n').find((l) => l.trim())?.trim() ?? approvedContent.slice(0, 160),
  });

  await chatbotDb.updateSessionVoiceProfile(sessionId, profile);
  return profile;
}

export function voiceCardPromptSuffix(profile: SessionVoiceProfile | undefined): string {
  return formatVoiceCardPromptBlock(profile?.voiceCard);
}


const PUBLISH_DRAFT_TOOLS = new Set(['post_on_connected_account', 'post_thread']);

export function augmentPublishToolDefinitions(
  tools: any[] | undefined,
  profile: SessionVoiceProfile | undefined,
): any[] {
  if (!tools?.length) return tools ?? [];
  const voiceBlock = formatVoiceCardPromptBlock(profile?.voiceCard);
  if (!voiceBlock.trim()) return tools;

  return tools.map((tool) => {
    const name = tool?.function?.name;
    if (!name || !PUBLISH_DRAFT_TOOLS.has(name)) return tool;
    const fn = tool.function ?? {};
    const params = fn.parameters ?? {};
    const props = { ...(params.properties ?? {}) };
    if (props.content) {
      props.content = {
        ...props.content,
        description: `${props.content.description ?? 'Post content.'}

${voiceBlock.trim()}`,
      };
    }
    return {
      ...tool,
      function: {
        ...fn,
        description: `${fn.description ?? name}

When drafting social content, mirror the Author Voice Card below.
${voiceBlock.trim()}`,
        parameters: { ...params, properties: props },
      },
    };
  });
}
