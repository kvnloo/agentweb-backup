import yaml from 'js-yaml';
import { getAzureClient, meterUsageFromResponse } from '../utils/llmClients';
import { taskDb } from './db';
import { Task } from '../types/task';

interface Position {
  x: number;
  y: number;
}

interface NodeData {
  label: string;
  prompt?: string;
  loopCount?: number;
  condition?: string;
}

interface Node {
  id: string;
  type: 'task' | 'loop' | 'condition';
  position: Position;
  data: NodeData;
  draggable?: boolean;
  selectable?: boolean;
  connectable?: boolean;
}

interface Edge {
  id: string;
  source: string;
  target: string;
  type?: string;
  markerEnd?: { type: string };
}

interface GeneratedWorkflow {
  yaml: string;
  nodes: Node[];
  edges: Edge[];
  message: string;
}

interface TaskReference {
  taskId: string;
  name: string;
  prompt: string;
  description?: string;
  category?: string;
}


function generateVisualization(workflowData: any): { nodes: Node[], edges: Edge[] } {
  // Calculate node positions
  const nodeSpacing = { x: 250, y: 100 };  // Increased spacing
  const startPosition = { x: 100, y: 50 };  // Starting position
  
  // Create a map to track node levels
  const nodeLevels = new Map<string, number>();
  const levelCounts = new Map<number, number>();
  
  // First pass: determine node levels based on connections
  workflowData.edges.forEach((edge: any) => {
    const sourceLevel = nodeLevels.get(edge.source) || 0;
    nodeLevels.set(edge.target, sourceLevel + 1);
    
    // Update count for this level
    const targetLevel = sourceLevel + 1;
    levelCounts.set(targetLevel, (levelCounts.get(targetLevel) || 0) + 1);
  });
  
  // Set level 0 for nodes without incoming edges
  workflowData.nodes.forEach((node: any) => {
    if (!nodeLevels.has(node.id)) {
      nodeLevels.set(node.id, 0);
      levelCounts.set(0, (levelCounts.get(0) || 0) + 1);
    }
  });

  // Second pass: assign positions based on levels
  const levelPositions = new Map<number, number>();  // Track x-position per level
  
  const nodes: Node[] = workflowData.nodes.map((node: any) => {
    const level = nodeLevels.get(node.id) || 0;
    const nodesInLevel = levelCounts.get(level) || 1;
    
    // Get or initialize x-position counter for this level
    const currentX = levelPositions.get(level) || 0;
    levelPositions.set(level, currentX + 1);
    
    // Calculate position
    const position = {
      x: startPosition.x + (currentX * nodeSpacing.x),
      y: startPosition.y + (level * nodeSpacing.y)
    };

    return {
      id: node.id,
      type: node.type,
      position,
      data: {
        label: node.data.label,
        prompt: node.data.prompt,
        loopCount: node.data.loopCount,
        condition: node.data.condition
      },
      draggable: true,
      selectable: true,
      connectable: true
    };
  });

  // Create edges with consistent styling
  const edges: Edge[] = workflowData.edges.map((edge: any) => ({
    id: edge.id || `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    markerEnd: { type: 'arrowclosed' }
  }));

  return { nodes, edges };
}

async function generateWorkflowYaml(
  description: string,
  userId: string,
  currentYaml?: string,
  retry: number = 3
): Promise<string> {
  // Get available tasks for the user
  const availableTasks = await taskDb.getAvailableTasks(userId);
  
  const functionDefinition = {
    name: 'generate_workflow',
    description: 'Generate a workflow definition in YAML format',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the workflow' },
        description: { type: 'string', description: 'Description of the workflow' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Node ID (format: node-1, node-2, etc.)' },
              type: { type: 'string', enum: ['task', 'loop', 'condition'] },
              data: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Label for the node. If taskId is provided, this must match the task name exactly.' },
                  prompt: { type: 'string', optional: true },
                  taskId: { type: 'string', description: 'ID of an existing task to reference', optional: true },
                  loopCount: { type: 'number', optional: true },
                  condition: { type: 'string', optional: true }
                },
                required: ['label']
              }
            },
            required: ['id', 'type', 'data']
          }
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Edge ID (format: edge-1, edge-2, etc.)' },
              source: { type: 'string', description: 'Source node ID' },
              target: { type: 'string', description: 'Target node ID' }
            },
            required: ['id', 'source', 'target']
          }
        }
      },
      required: ['name', 'description', 'nodes', 'edges']
    }
  };

  const systemMessage = `You are a workflow generation assistant. Generate a workflow based on the user's description.
The workflow should be logically structured with proper connections between nodes.
If modifying an existing workflow, maintain its overall structure while applying the requested changes.

Available tasks that can be referenced in the workflow:
${availableTasks.map(task => `
Task ID: ${(task as any).taskId}
Name: ${(task as any).name}
Description: ${(task as any).description || 'No description'}
Category: ${(task as any).category || 'Uncategorized'}
Prompt: ${(task as any).prompt}
`).join('\n')}

When creating task nodes, you can either:
1. Reference an existing task by including its taskId in the node data
   - When using taskId, the node's label MUST exactly match the task's name
   - This ensures consistency between the workflow visualization and the actual task
2. Create a new task by providing a prompt
   - In this case, you can use any appropriate label

If referencing an existing task, use its taskId and the task's prompt will be automatically used.
If creating a new task, provide a prompt that describes what the task should do.`;

  // Un-metered: metered explicitly below via meterUsageFromResponse; auto-metering
  // here would double-record the same response (ENG-200).
  const openai = getAzureClient({ userId, feature: 'workflow_gen' }, process.env.AZURE_OPENAI_DEPLOYMENT, { metered: false });
  const completion = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: `Current workflow:\n${currentYaml || 'None'}\n\nGenerate workflow: ${description}` }
    ],
    functions: [functionDefinition],
    function_call: { name: 'generate_workflow' }
  });

  meterUsageFromResponse({
    userId,
    model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
    provider: 'azure',
    feature: 'workflow_gen',
  }, completion);

  const functionCall = completion.choices[0].message.function_call;
  if (!functionCall?.arguments) {
    throw new Error('No workflow definition generated');
  }

  const workflowDefinition = JSON.parse(functionCall.arguments);

  // Validate that task labels match task names when taskId is used
  const validationErrors: string[] = [];
  workflowDefinition.nodes.forEach((node: any) => {
    if (node.data.taskId) {
      const task = availableTasks.find(t => (t as any).taskId === node.data.taskId);
      if (!task) {
        validationErrors.push(`Task with ID ${node.data.taskId} not found`);
      } else if (node.data.label !== (task as any).name) {
        validationErrors.push(`Node label "${node.data.label}" does not match task name "${(task as any).name}" for task ID ${node.data.taskId}`);
      }
    }
  });

  if (validationErrors.length > 0) {
    // If there are validation errors and we still have retries left, regenerate the workflow
    if (retry > 0) {
      const errorMessage = `Please regenerate the workflow. The following issues were found:\n${validationErrors.join('\n')}`;
      return generateWorkflowYaml(`${description}\n\n${errorMessage}`, userId, currentYaml, retry - 1);
    } else {
      // If we're out of retries, throw an error with all validation issues
      throw new Error(`Failed to generate valid workflow after ${3 - retry} attempts. Validation errors:\n${validationErrors.join('\n')}`);
    }
  }

  return yaml.dump(workflowDefinition);
}

export async function generateWorkflowFromDescription(
  message: string,
  userId: string,
  currentYaml?: string
): Promise<GeneratedWorkflow> {
  try {
    // Generate the YAML using function calling
    const yamlContent = await generateWorkflowYaml(message, userId, currentYaml);
    const workflowData = yaml.load(yamlContent) as any;

    // Generate visualization from the YAML data
    const { nodes, edges } = generateVisualization(workflowData);

    // Get a user-friendly explanation of the workflow
    // Un-metered: metered explicitly below via meterUsageFromResponse; auto-metering
  // here would double-record the same response (ENG-200).
  const openai = getAzureClient({ userId, feature: 'workflow_gen' }, process.env.AZURE_OPENAI_DEPLOYMENT, { metered: false });
    const explanation = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
      messages: [
        { 
          role: 'system', 
          content: 'Provide a one-sentence high-level summary of what this workflow does. Do not explain individual steps or implementation details as they are visible in the workflow itself.' 
        },
        { role: 'user', content: `Summarize this workflow:\n${yamlContent}` }
      ],
      temperature: 0.7,
      max_tokens: 150
    });

    meterUsageFromResponse({
      userId,
      model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
      provider: 'azure',
      feature: 'workflow_explain',
    }, explanation);

    return {
      yaml: yamlContent,
      nodes,
      edges,
      message: explanation.choices[0].message.content || 'Workflow generated successfully.'
    };
  } catch (error) {
    console.error('Error generating workflow:', error);
    throw error;
  }
} 