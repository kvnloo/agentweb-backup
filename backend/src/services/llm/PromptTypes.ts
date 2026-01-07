/**
 * Prompt Template Types
 * 
 * Defines the structure for system prompts and templates.
 */

/**
 * Prompt section that can be composed together
 */
export interface PromptSection {
  /** Section identifier */
  id: string;
  
  /** Section title for display */
  title: string;
  
  /** Section content */
  content: string;
  
  /** Priority for ordering (lower = higher priority) */
  priority: number;
  
  /** Whether this section is required */
  required: boolean;
  
  /** Tags for filtering */
  tags?: string[];
}

/**
 * Prompt template structure
 */
export interface PromptTemplate {
  /** Unique template identifier */
  id: string;
  
  /** Template name */
  name: string;
  
  /** Template version */
  version: string;
  
  /** Template description */
  description?: string;
  
  /** Base content (static part) */
  baseContent: string;
  
  /** Dynamic sections that can be included */
  sections: PromptSection[];
  
  /** Variables that can be substituted */
  variables: PromptVariable[];
  
  /** Whether this template is active */
  active: boolean;
  
  /** Created timestamp */
  createdAt: Date;
  
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Variable definition for prompt templates
 */
export interface PromptVariable {
  /** Variable name (used in {{variable}} syntax) */
  name: string;
  
  /** Variable description */
  description: string;
  
  /** Default value */
  defaultValue?: string;
  
  /** Whether this variable is required */
  required: boolean;
  
  /** Variable type for validation */
  type: 'string' | 'number' | 'boolean' | 'json' | 'date';
}

/**
 * Prompt context for rendering
 */
export interface PromptContext {
  /** Current date */
  currentDate?: string;
  
  /** User information */
  userId?: string;
  userName?: string;
  
  /** Session information */
  sessionId?: string;
  
  /** Available templates context */
  templatesContext?: string;
  
  /** Work plan context */
  workPlanContext?: string;
  
  /** Custom variables */
  [key: string]: any;
}

/**
 * Prompt variation for A/B testing
 */
export interface PromptVariation {
  /** Variation identifier */
  id: string;
  
  /** Variation name */
  name: string;
  
  /** Modified content or sections */
  overrides: {
    baseContent?: string;
    sections?: Partial<PromptSection>[];
  };
  
  /** Weight for random selection (0-100) */
  weight: number;
  
  /** Whether this variation is active */
  active: boolean;
}
