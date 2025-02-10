import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactFlow, { 
  Node,
  Edge,
  Controls,
  Background,
  MiniMap,
  NodeChange,
  EdgeChange,
  Connection,
  addEdge,
  MarkerType,
  NodeTypes,
  NodeProps
} from 'reactflow';
import 'reactflow/dist/style.css';
import yaml from 'js-yaml';

import {
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  IconButton,
  Snackbar,
  Alert,
  CircularProgress
} from '@mui/material';

import {
  Save as SaveIcon,
  PlayArrow as RunIcon,
  ArrowBack as ArrowBackIcon,
  Send as SendIcon
} from '@mui/icons-material';

import TaskNode from '../components/workflow/nodes/TaskNode';
import LoopNode from '../components/workflow/nodes/LoopNode';
import ConditionNode from '../components/workflow/nodes/ConditionNode';
import { useAuth } from '../contexts/AuthContext';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

type NodeData = {
  label: string;
  taskId?: string;
  prompt?: string;
  loopCount?: number;
  condition?: string;
};

type CustomNode = Node<NodeData>;

interface WorkflowData {
  id: string;
  name: string;
  description: string;
  yaml: string;
  nodes: CustomNode[];
  edges: Edge[];
}

// Define node types
const nodeTypes: Record<string, React.ComponentType<NodeProps<NodeData>>> = {
  task: TaskNode,
  loop: LoopNode,
  condition: ConditionNode
};

// Add this function before the WorkflowBuilder component
function generateVisualization(workflowData: any): { nodes: Node[], edges: Edge[] } {
  if (!workflowData || !workflowData.nodes || !workflowData.edges) {
    console.error('Invalid workflow data:', workflowData);
    return { nodes: [], edges: [] };
  }

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
      type: node.type || 'task',  // Default to task type if not specified
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

  // Create edges with consistent styling and unique IDs
  const edges: Edge[] = workflowData.edges.map((edge: any) => ({
    id: `edge-${edge.source}-${edge.target}-${Date.now()}`,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed }
  }));

  return { nodes, edges };
}

export default function WorkflowBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { token } = useAuth();
  const [workflow, setWorkflow] = useState<WorkflowData>({
    id: id || 'new',
    name: '',
    description: '',
    yaml: '',
    nodes: [],
    edges: []
  });
  
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: 'Hi! I can help you create a workflow. You can describe what you want to do, and I\'ll help you build it. For example, you could say "Create a workflow that checks email every morning and sends a summary to Slack".'
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'error'>('success');
  
  const messagesEndRef = useRef<null | HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const fetchWorkflow = async () => {
      if (id && id !== 'new') {
        try {
          const baseUrl = import.meta.env.VITE_API_URL || '';
          const response = await fetch(`${baseUrl}/api/workflows/${id}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          });

          if (!response.ok) {
            throw new Error('Failed to fetch workflow');
          }

          const data = await response.json();
          console.log('Fetched workflow:', data);

          // Set messages first if they exist
          if (data.messages) {
            setMessages(data.messages);
          }

          // Parse YAML to get visualization data
          const workflowData = yaml.load(data.yaml) as any;
          const { nodes: generatedNodes, edges: generatedEdges } = generateVisualization(workflowData);

          setWorkflow({
            id: data.workflowId,
            name: data.name,
            description: data.description,
            yaml: data.yaml || '',
            nodes: generatedNodes,
            edges: generatedEdges
          });

          // Set nodes and edges in ReactFlow state
          setNodes(generatedNodes);
          setEdges(generatedEdges);
        } catch (error) {
          console.error('Error fetching workflow:', error);
          setShowSnackbar(true);
          setSnackbarMessage('Failed to load workflow');
          setSnackbarSeverity('error');
        }
      }
    };

    fetchWorkflow();
  }, [id, token]);

  // Update the useEffect hook that watches workflow.yaml
  useEffect(() => {
    if (workflow.yaml) {
      try {
        const workflowData = yaml.load(workflow.yaml) as any;
        console.log('Parsed workflow data:', workflowData);  // Add logging
        
        if (workflowData && workflowData.nodes && workflowData.edges) {
          const { nodes: generatedNodes, edges: generatedEdges } = generateVisualization(workflowData);
          console.log('Generated visualization:', { nodes: generatedNodes, edges: generatedEdges });  // Add logging
          
          setNodes(generatedNodes);
          setEdges(generatedEdges);
        } else {
          console.error('Invalid workflow data structure');
        }
      } catch (error) {
        console.error('Error parsing workflow YAML:', error);
      }
    }
  }, [workflow.yaml]);

  const onNodesChange = (changes: NodeChange[]) => {
    setNodes((nds) => {
      const updatedNodes = [...nds];
      changes.forEach((change) => {
        if (change.type === 'position' && change.position) {
          const nodeIndex = updatedNodes.findIndex((n) => n.id === change.id);
          if (nodeIndex !== -1) {
            updatedNodes[nodeIndex] = {
              ...updatedNodes[nodeIndex],
              position: change.position
            };
          }
        }
      });
      return updatedNodes;
    });
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    setEdges((eds) => {
      const updatedEdges = [...eds];
      changes.forEach((change) => {
        if (change.type === 'remove') {
          const edgeIndex = updatedEdges.findIndex((e) => e.id === change.id);
          if (edgeIndex !== -1) {
            updatedEdges.splice(edgeIndex, 1);
          }
        }
      });
      return updatedEdges;
    });
  };

  const onConnect = (connection: Connection) => {
    setEdges((eds) => addEdge({
      ...connection,
      id: `edge-${Date.now()}`,
      markerEnd: { type: MarkerType.ArrowClosed }
    }, eds));
  };

  const handleSendMessage = async () => {
    if (!input.trim()) return;

    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const baseUrl = import.meta.env.VITE_API_URL || '';
      const response = await fetch(`${baseUrl}/api/workflows/generate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: userMessage,
          currentYaml: workflow.yaml
        }),
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to generate workflow');
      }

      const data = await response.json();
      
      // Update workflow with new YAML
      setWorkflow(prev => ({
        ...prev,
        yaml: data.yaml
      }));

      // Add assistant's response
      setMessages(prev => [...prev, { role: 'assistant', content: data.message }]);
    } catch (error) {
      console.error('Error generating workflow:', error);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: 'Sorry, I encountered an error while generating the workflow. Please try again.' 
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      // Parse YAML to get name and description
      const workflowYaml = yaml.load(workflow.yaml) as any;
      const workflowData = {
        name: workflowYaml?.name || 'Untitled Workflow',
        description: workflowYaml?.description || '',
        yaml: workflow.yaml,
        messages: messages,
        taskCount: nodes.filter(node => node.type === 'task').length,
        nodes: nodes.map(node => ({
          ...node,
          // Remove ReactFlow-specific properties
          selected: undefined,
          dragging: undefined,
          resizing: undefined
        })),
        edges: edges
      };

      const baseUrl = import.meta.env.VITE_API_URL || '';
      const url = id && id !== 'new' 
        ? `${baseUrl}/api/workflows/${id}`
        : `${baseUrl}/api/workflows`;

      const method = id && id !== 'new' ? 'PUT' : 'POST';

      console.log('Saving workflow:', {
        url,
        method,
        data: workflowData
      });

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(workflowData),
        credentials: 'include'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(
          errorData?.error || 
          `Failed to save workflow: ${response.status} ${response.statusText}`
        );
      }

      const savedWorkflow = await response.json();
      console.log('Workflow saved successfully:', savedWorkflow);
      
      // Update the workflow ID if this was a new workflow
      if (id === 'new') {
        navigate(`/workflows/${savedWorkflow.workflowId}/edit`, { replace: true });
      }

      setWorkflow(prevWorkflow => ({
        ...prevWorkflow,
        id: savedWorkflow.workflowId  // Use workflowId instead of id
      }));

      setShowSnackbar(true);
      setSnackbarMessage('Workflow saved successfully');
      setSnackbarSeverity('success');
    } catch (error) {
      console.error('Error saving workflow:', error);
      setShowSnackbar(true);
      setSnackbarMessage(error instanceof Error ? error.message : 'Failed to save workflow');
      setSnackbarSeverity('error');
    }
  };

  const handleRun = async () => {
    if (!workflow.id || workflow.id === 'new') {
      setSnackbarMessage('Please save the workflow before running it');
      setSnackbarSeverity('error');
      setShowSnackbar(true);
      return;
    }
    navigate(`/workflows/${workflow.id}/run`);
  };

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <Paper sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconButton onClick={() => navigate('/workflows')}>
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h6">{workflow.name || 'New Workflow'}</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="contained"
            startIcon={<RunIcon />}
            onClick={handleRun}
          >
            Run
          </Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSave}
          >
            Save
          </Button>
        </Box>
      </Paper>

      {/* Main Content */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Chat Section */}
        <Box sx={{ 
          width: '400px', 
          borderRight: 1, 
          borderColor: 'divider',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {/* Messages */}
          <Box sx={{ 
            flex: 1, 
            overflowY: 'auto', 
            p: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 2
          }}>
            {messages.map((message, index) => (
              <Paper
                key={index}
                sx={{
                  p: 2,
                  maxWidth: '90%',
                  alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                  bgcolor: message.role === 'user' ? 'primary.main' : 'background.paper'
                }}
              >
                <Typography
                  sx={{
                    color: message.role === 'user' ? 'white' : 'text.primary',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {message.content}
                </Typography>
              </Paper>
            ))}
            <div ref={messagesEndRef} />
          </Box>

          {/* Input */}
          <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                fullWidth
                placeholder="Describe your workflow..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                multiline
                maxRows={4}
                disabled={loading}
              />
              <IconButton 
                color="primary" 
                onClick={handleSendMessage}
                disabled={loading || !input.trim()}
              >
                {loading ? <CircularProgress size={24} /> : <SendIcon />}
              </IconButton>
            </Box>
          </Box>
        </Box>

        {/* Visualization Section */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* YAML View */}
          <Paper sx={{ 
            flex: 0.4, 
            overflow: 'auto',
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: '#1e1e1e',  // Dark background for code
            p: 2
          }}>
            <Typography variant="h6" sx={{ color: '#fff', mb: 2 }}>
              YAML Definition (Editable)
            </Typography>
            <TextField
              multiline
              fullWidth
              value={workflow.yaml}
              onChange={(e) => setWorkflow(prev => ({ ...prev, yaml: e.target.value }))}
              sx={{
                '& .MuiInputBase-root': {
                  fontFamily: '"Fira Code", "Consolas", monospace',
                  fontSize: '0.9rem',
                  color: '#d4d4d4',
                  backgroundColor: '#252525',
                },
                '& .MuiOutlinedInput-notchedOutline': {
                  borderColor: '#333',
                },
                '& .MuiInputBase-input': {
                  padding: 2,
                }
              }}
            />
          </Paper>

          {/* Flow View */}
          <Box sx={{ 
            flex: 0.6,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: '500px',
            bgcolor: '#f8f9fa'
          }}>
            <Typography variant="h6" sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
              Workflow Visualization
            </Typography>
            <Box sx={{ 
              flex: 1,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              overflow: 'hidden'
            }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                nodeTypes={nodeTypes}
                fitView
                defaultEdgeOptions={{
                  type: 'smoothstep',
                  markerEnd: { type: MarkerType.ArrowClosed }
                }}
                style={{ background: '#f8f9fa' }}
                proOptions={{ hideAttribution: true }}
              >
                <Controls />
                <Background />
              </ReactFlow>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Snackbar */}
      <Snackbar
        open={showSnackbar}
        autoHideDuration={6000}
        onClose={() => setShowSnackbar(false)}
      >
        <Alert
          onClose={() => setShowSnackbar(false)}
          severity={snackbarSeverity}
          sx={{ width: '100%' }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
} 