/**
 * LLM Services Module
 * 
 * Exports LLM client factory, prompt builder, and prompt templates.
 */

export {
  LLMClientFactory,
  llmClientFactory,
  LLMModelConfig,
  LLMCallOptions,
  LLMResponse
} from './LLMClientFactory';

export {
  PromptBuilder,
  promptBuilder,
  PromptSection
} from './PromptBuilder';

// Prompt Types
export {
  PromptTemplate,
  PromptVariable,
  PromptContext,
  PromptVariation
} from './PromptTypes';

// Prompt Sections
export {
  ALL_PROMPT_SECTIONS,
  IDENTITY_SECTION,
  CAPABILITIES_SECTION,
  FILE_ATTACHMENTS_SECTION,
  TASK_CREATION_SECTION,
  COMMUNICATION_SECTION,
  FORMATTING_SECTION,
  WORK_PLAN_SECTION,
  LEAD_MANAGEMENT_SECTION,
  GTM_SECTION,
  getSectionsByTags,
  getRequiredSections,
  composePrompt
} from './PromptSections';

// Prompt Template Service
export {
  PromptTemplateService,
  promptTemplateService,
  PromptVersion
} from './PromptTemplateService';
