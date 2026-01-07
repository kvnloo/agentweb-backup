/**
 * Special Tool Handlers
 * 
 * Handlers for tools that require custom logic beyond simple method delegation.
 * These handle JSON parsing, complex transformations, etc.
 */

import { ToolHandler, ToolContext } from '../types';

/**
 * Args for create_task_from_template
 */
interface CreateTaskFromTemplateArgs {
  template_id: string;
  parameters_json: string;
  attach_previous_task_results?: boolean;
  attached_file_urls?: string[];
  async?: boolean;
}

/**
 * Handler for create_task_from_template
 * Parses parameters_json before calling the service method
 */
export function createTaskFromTemplateHandler(service: any): ToolHandler<CreateTaskFromTemplateArgs> {
  return {
    name: 'create_task_from_template',
    
    async execute(args: CreateTaskFromTemplateArgs, context: ToolContext) {
      // Parse parameters JSON
      let parameters: Record<string, string>;
      try {
        parameters = JSON.parse(args.parameters_json || '{}');
      } catch (parseError) {
        return {
          success: false,
          message: 'Invalid parameters JSON format. Please provide a valid JSON string.',
          status: 'invalid_json'
        };
      }
      
      const attachPreviousTaskResults = args.attach_previous_task_results !== false;
      const attachedFileUrls = args.attached_file_urls || [];
      const async = args.async ?? false;
      
      return service.createTaskFromTemplate(
        args.template_id,
        parameters,
        context.userId,
        context.sessionId,
        attachPreviousTaskResults,
        attachedFileUrls,
        async
      );
    }
  };
}

/**
 * Args for create_task_from_prompt
 */
interface CreateTaskFromPromptArgs {
  task_name: string;
  prompt: string;
  category: string;
  attach_previous_task_results?: boolean;
  attached_file_urls?: string[];
  async?: boolean;
}

/**
 * Handler for create_task_from_prompt
 */
export function createTaskFromPromptHandler(service: any): ToolHandler<CreateTaskFromPromptArgs> {
  return {
    name: 'create_task_from_prompt',
    
    async execute(args: CreateTaskFromPromptArgs, context: ToolContext) {
      const attachPreviousTaskResults = args.attach_previous_task_results !== false;
      const attachedFileUrls = args.attached_file_urls || [];
      const async = args.async ?? false;
      
      return service.createTaskFromPrompt(
        args.task_name,
        args.prompt,
        args.category,
        context.userId,
        context.sessionId,
        attachPreviousTaskResults,
        attachedFileUrls,
        async
      );
    }
  };
}

/**
 * Args for create_image_task_from_prompt (deprecated)
 */
interface CreateImageTaskArgs {
  task_name: string;
  prompt: string;
  category?: string;
  attach_previous_task_results?: boolean;
}

/**
 * Handler for create_image_task_from_prompt
 */
export function createImageTaskFromPromptHandler(service: any): ToolHandler<CreateImageTaskArgs> {
  return {
    name: 'create_image_task_from_prompt',
    
    async execute(args: CreateImageTaskArgs, context: ToolContext) {
      const attachPreviousTaskResults = args.attach_previous_task_results !== false;
      
      return service.createImageTaskFromPrompt(
        args.task_name,
        args.prompt,
        args.category || 'Creatives',
        context.userId,
        context.sessionId,
        attachPreviousTaskResults
      );
    }
  };
}

/**
 * Args for create_revision (deprecated)
 */
interface CreateRevisionArgs {
  task_id: string;
  execution_id: string;
  revision_prompt: string;
  target_result_name?: string;
}

/**
 * Handler for create_revision
 */
export function createRevisionHandler(service: any): ToolHandler<CreateRevisionArgs> {
  return {
    name: 'create_revision',
    
    async execute(args: CreateRevisionArgs, context: ToolContext) {
      return service.createRevision(
        args.task_id,
        args.execution_id,
        args.revision_prompt,
        context.userId,
        args.target_result_name
      );
    }
  };
}

/**
 * Args for update_book_content
 */
interface UpdateBookContentArgs {
  book_id: string;
  section_id: string;
  chapter_id?: string;
  replacement_json: string;
}

/**
 * Handler for update_book_content (parses replacement_json)
 */
export function updateBookContentHandler(service: any): ToolHandler<UpdateBookContentArgs> {
  return {
    name: 'update_book_content',
    
    async execute(args: UpdateBookContentArgs, context: ToolContext) {
      let replacementInstructions: any[] = [];
      
      try {
        if (args.replacement_json) {
          replacementInstructions = JSON.parse(args.replacement_json);
        }
      } catch (error) {
        return {
          success: false,
          message: 'Invalid JSON in replacement_json',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
      
      return service.updateBookContent(
        args.book_id,
        args.section_id,
        args.chapter_id,
        replacementInstructions,
        context.userId
      );
    }
  };
}

/**
 * Args for create_html_from_template
 */
interface CreateHtmlFromTemplateArgs {
  template_name: string;
  variable_values_json: string;
  array_variable_values_json: string;
}

/**
 * Handler for create_html_from_template (parses JSON args)
 */
export function createHtmlFromTemplateHandler(service: any): ToolHandler<CreateHtmlFromTemplateArgs> {
  return {
    name: 'create_html_from_template',
    
    async execute(args: CreateHtmlFromTemplateArgs, context: ToolContext) {
      if (!args.template_name) {
        return { success: false, message: 'template_name is required' };
      }
      
      let variableValues = {};
      let arrayVariableValues = {};
      
      try {
        if (args.variable_values_json) {
          variableValues = JSON.parse(args.variable_values_json);
        }
      } catch (error) {
        return {
          success: false,
          message: 'Invalid JSON in variable_values_json',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
      
      try {
        if (args.array_variable_values_json) {
          arrayVariableValues = JSON.parse(args.array_variable_values_json);
        }
      } catch (error) {
        return {
          success: false,
          message: 'Invalid JSON in array_variable_values_json',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
      
      return service.createHtmlFromTemplate(
        context.llmModel,
        args.template_name,
        variableValues,
        arrayVariableValues,
        context.userId,
        context.sessionId
      );
    }
  };
}

/**
 * Args for update_html_file
 */
interface UpdateHtmlFileArgs {
  file_url: string;
  update_type: 'part' | 'full';
  replacement_json: string;
}

/**
 * Handler for update_html_file (parses replacement_json)
 */
export function updateHtmlFileHandler(service: any): ToolHandler<UpdateHtmlFileArgs> {
  return {
    name: 'update_html_file',
    
    async execute(args: UpdateHtmlFileArgs, context: ToolContext) {
      if (!args.file_url) {
        return { success: false, message: 'file_url is required' };
      }
      if (!args.update_type) {
        return { success: false, message: 'update_type is required' };
      }
      if (!args.replacement_json) {
        return { success: false, message: 'replacement_json is required' };
      }
      
      let replacementInstructions: any;
      try {
        replacementInstructions = JSON.parse(args.replacement_json);
      } catch (error) {
        return {
          success: false,
          message: 'Invalid JSON in replacement_json',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
      
      return service.updateHtmlFile(
        args.file_url,
        args.update_type,
        replacementInstructions,
        context.userId,
        context.sessionId
      );
    }
  };
}

/**
 * Get all special handlers
 */
export function getSpecialHandlers(service: any): ToolHandler[] {
  return [
    createTaskFromTemplateHandler(service),
    createTaskFromPromptHandler(service),
    createImageTaskFromPromptHandler(service),
    createRevisionHandler(service),
    updateBookContentHandler(service),
    createHtmlFromTemplateHandler(service),
    updateHtmlFileHandler(service)
  ];
}
