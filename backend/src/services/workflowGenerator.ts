import yaml from 'js-yaml';
import OpenAI from 'openai';

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

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY }
});

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
  currentYaml?: string
): Promise<string> {
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
                  label: { type: 'string' },
                  prompt: { type: 'string', optional: true },
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
If modifying an existing workflow, maintain its overall structure while applying the requested changes.`;

  const completion = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: `Current workflow:\n${currentYaml || 'None'}\n\nGenerate workflow: ${description}` }
    ],
    functions: [functionDefinition],
    function_call: { name: 'generate_workflow' }
  });

  const functionCall = completion.choices[0].message.function_call;
  if (!functionCall?.arguments) {
    throw new Error('No workflow definition generated');
  }

  const workflowDefinition = JSON.parse(functionCall.arguments);
  return yaml.dump(workflowDefinition);
}

export async function generateWorkflowFromDescription(
  message: string,
  currentYaml?: string
): Promise<GeneratedWorkflow> {
  try {
    // Generate the YAML using function calling
    const yamlContent = await generateWorkflowYaml(message, currentYaml);
    const workflowData = yaml.load(yamlContent) as any;

    // Generate visualization from the YAML data
    const { nodes, edges } = generateVisualization(workflowData);

    // Get a user-friendly explanation of the workflow
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