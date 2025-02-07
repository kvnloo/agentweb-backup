import React, { useState, useEffect } from 'react';
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

import {
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  Drawer,
  IconButton,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  ListItemButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
  Alert
} from '@mui/material';

import {
  Save as SaveIcon,
  PlayArrow as RunIcon,
  Close as CloseIcon,
  Add as AddIcon,
  Settings as SettingsIcon,
  ArrowBack as ArrowBackIcon,
  Task as TaskIcon,
  Loop as LoopIcon,
  CallSplit as BranchIcon
} from '@mui/icons-material';

import TaskNode from '../components/workflow/nodes/TaskNode';
import LoopNode from '../components/workflow/nodes/LoopNode';
import ConditionNode from '../components/workflow/nodes/ConditionNode';

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
  nodes: CustomNode[];
  edges: Edge[];
}

// Define node types
const nodeTypes: Record<string, React.ComponentType<NodeProps<NodeData>>> = {
  task: TaskNode,
  loop: LoopNode,
  condition: ConditionNode
};

// Define node type icons for the drawer
const nodeTypeIcons = {
  task: <TaskIcon />,
  loop: <LoopIcon />,
  condition: <BranchIcon />
};

export default function WorkflowBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<WorkflowData>({
    id: id || 'new',
    name: '',
    description: '',
    nodes: [],
    edges: []
  });
  
  const [nodes, setNodes] = useState<CustomNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'error'>('success');

  useEffect(() => {
    const fetchWorkflow = async () => {
      if (id && id !== 'new') {
        try {
          const baseUrl = import.meta.env.VITE_API_URL || '';
          const response = await fetch(`${baseUrl}/api/workflows/${id}`, {
            headers: {
              'Authorization': `Bearer ${localStorage.getItem('token')}`,
              'Content-Type': 'application/json'
            },
            credentials: 'include'
          });

          if (!response.ok) {
            throw new Error('Failed to fetch workflow');
          }

          const data = await response.json();
          console.log('Fetched workflow:', data);

          setWorkflow({
            id: data.workflowId,
            name: data.name,
            description: data.description,
            nodes: [],
            edges: []
          });

          // Set nodes and edges if they exist
          if (data.nodes) {
            setNodes(data.nodes.map((node: any) => ({
              ...node,
              // Ensure node has all required ReactFlow properties
              draggable: true,
              selectable: true,
              connectable: true
            })));
          }

          if (data.edges) {
            setEdges(data.edges.map((edge: any) => ({
              ...edge,
              // Add any default edge properties
              markerEnd: { type: MarkerType.ArrowClosed }
            })));
          }
        } catch (error) {
          console.error('Error fetching workflow:', error);
          setShowSnackbar(true);
          setSnackbarMessage('Failed to load workflow');
          setSnackbarSeverity('error');
        }
      }
    };

    fetchWorkflow();
  }, [id]);

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
      markerEnd: { type: MarkerType.ArrowClosed }
    }, eds));
  };

  const handleAddNode = (type: string) => {
    console.log('Adding new node of type:', type);
    
    // Calculate position based on existing nodes
    const yOffset = 100;
    const xOffset = 50;
    const existingNodes = nodes.length;
    const position = {
      x: 250 + (existingNodes * xOffset),
      y: 100 + (existingNodes * yOffset)
    };

    const newNode: CustomNode = {
      id: `${Date.now()}`,
      type,
      position,
      data: { 
        label: `New ${type}`,
        ...(type === 'task' && { taskId: '', prompt: '' }),
        ...(type === 'loop' && { loopCount: 1 }),
        ...(type === 'condition' && { condition: '' })
      },
      draggable: true,
      selectable: true,
      connectable: true
    };
    console.log('Created new node:', newNode);
    setNodes((currentNodes) => [...currentNodes, newNode]);
    setIsDrawerOpen(false);
  };

  const handleNodeClick = (event: React.MouseEvent, node: Node) => {
    console.log('Node clicked:', node);
    setSelectedNode(node);
    setIsSettingsOpen(true);
  };

  const handleSave = async () => {
    try {
      if (!workflow.name.trim()) {
        setSnackbarMessage('Please enter a workflow name');
        setSnackbarSeverity('error');
        setShowSnackbar(true);
        return;
      }

      const workflowData = {
        name: workflow.name,
        description: workflow.description,
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
          'Authorization': `Bearer ${localStorage.getItem('token')}`
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
        navigate(`/workflows/${savedWorkflow.id}/edit`, { replace: true });
      }

      setWorkflow(prevWorkflow => ({
        ...prevWorkflow,
        id: savedWorkflow.id
      }));

      setShowSnackbar(true);
      setSnackbarMessage('Workflow saved successfully');
      setSnackbarSeverity('success');
      setIsSaveDialogOpen(false);
    } catch (error) {
      console.error('Error saving workflow:', error);
      setShowSnackbar(true);
      setSnackbarMessage(error instanceof Error ? error.message : 'Failed to save workflow');
      setSnackbarSeverity('error');
    }
  };

  const handleRun = async () => {
    try {
      if (!workflow.id || workflow.id === 'new') {
        setSnackbarMessage('Please save the workflow before running it');
        setSnackbarSeverity('error');
        setShowSnackbar(true);
        return;
      }

      const response = await fetch(`/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to run workflow');
      }

      const result = await response.json();
      setShowSnackbar(true);
      setSnackbarMessage('Workflow started successfully');
      setSnackbarSeverity('success');
    } catch (error) {
      console.error('Error running workflow:', error);
      setShowSnackbar(true);
      setSnackbarMessage('Failed to run workflow');
      setSnackbarSeverity('error');
    }
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
            startIcon={<AddIcon />}
            onClick={() => setIsDrawerOpen(true)}
          >
            Add Node
          </Button>
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
            onClick={() => setIsSaveDialogOpen(true)}
          >
            Save
          </Button>
        </Box>
      </Paper>

      {/* Flow Editor */}
      <Box sx={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          fitView
          defaultEdgeOptions={{
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed }
          }}
        >
          <Controls />
          <Background />
          <MiniMap />
        </ReactFlow>
      </Box>

      {/* Add Node Drawer */}
      <Drawer
        anchor="right"
        open={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
      >
        <Box sx={{ width: 300, p: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">Add Node</Typography>
            <IconButton onClick={() => setIsDrawerOpen(false)}>
              <CloseIcon />
            </IconButton>
          </Box>
          <Divider />
          <List>
            {Object.entries(nodeTypes).map(([type]) => (
              <ListItem key={type} disablePadding>
                <ListItemButton onClick={() => handleAddNode(type)}>
                  <ListItemIcon>
                    {nodeTypeIcons[type as keyof typeof nodeTypeIcons]}
                  </ListItemIcon>
                  <ListItemText primary={type.charAt(0).toUpperCase() + type.slice(1)} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>

      {/* Node Settings Dialog */}
      <Dialog
        open={isSettingsOpen}
        onClose={() => {
          console.log('Closing dialog');
          setIsSettingsOpen(false);
          setSelectedNode(null);
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {selectedNode?.type === 'task' ? 'Edit Task' : 
           selectedNode?.type ? `${selectedNode.type.charAt(0).toUpperCase()}${selectedNode.type.slice(1)} Settings` : 
           'Node Settings'}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            {selectedNode?.type === 'task' ? (
              <>
                <TextField
                  label="Task Name"
                  fullWidth
                  value={selectedNode?.data?.label || ''}
                  onChange={(e) => {
                    if (selectedNode) {
                      const updatedNode = {
                        ...selectedNode,
                        data: { ...selectedNode.data, label: e.target.value }
                      };
                      setNodes((nds) =>
                        nds.map((node) =>
                          node.id === selectedNode.id ? updatedNode : node
                        )
                      );
                      setSelectedNode(updatedNode);
                    }
                  }}
                />
                <TextField
                  label="Task Prompt"
                  fullWidth
                  multiline
                  rows={4}
                  placeholder="Enter the instructions for this task..."
                  value={selectedNode?.data?.prompt || ''}
                  onChange={(e) => {
                    if (selectedNode) {
                      const updatedNode = {
                        ...selectedNode,
                        data: { ...selectedNode.data, prompt: e.target.value }
                      };
                      setNodes((nds) =>
                        nds.map((node) =>
                          node.id === selectedNode.id ? updatedNode : node
                        )
                      );
                      setSelectedNode(updatedNode);
                    }
                  }}
                />
              </>
            ) : (
              <>
                <TextField
                  label="Label"
                  fullWidth
                  value={selectedNode?.data?.label || ''}
                  onChange={(e) => {
                    if (selectedNode) {
                      setNodes((nds) =>
                        nds.map((node) =>
                          node.id === selectedNode.id
                            ? { ...node, data: { ...node.data, label: e.target.value } }
                            : node
                        )
                      );
                    }
                  }}
                />

                {selectedNode?.type === 'loop' && (
                  <TextField
                    label="Loop Count"
                    type="number"
                    fullWidth
                    value={selectedNode?.data?.loopCount || 1}
                    onChange={(e) => {
                      if (selectedNode) {
                        setNodes((nds) =>
                          nds.map((node) =>
                            node.id === selectedNode.id
                              ? { ...node, data: { ...node.data, loopCount: parseInt(e.target.value) || 1 } }
                              : node
                          )
                        );
                      }
                    }}
                  />
                )}

                {selectedNode?.type === 'condition' && (
                  <TextField
                    label="Condition"
                    fullWidth
                    multiline
                    rows={2}
                    value={selectedNode?.data?.condition || ''}
                    onChange={(e) => {
                      if (selectedNode) {
                        setNodes((nds) =>
                          nds.map((node) =>
                            node.id === selectedNode.id
                              ? { ...node, data: { ...node.data, condition: e.target.value } }
                              : node
                          )
                        );
                      }
                    }}
                  />
                )}
              </>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsSettingsOpen(false)}>Cancel</Button>
          <Button 
            onClick={() => setIsSettingsOpen(false)} 
            color="primary"
            variant="contained"
          >
            Apply
          </Button>
        </DialogActions>
      </Dialog>

      {/* Save Dialog */}
      <Dialog
        open={isSaveDialogOpen}
        onClose={() => setIsSaveDialogOpen(false)}
      >
        <DialogTitle>Save Workflow</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Workflow Name"
            fullWidth
            value={workflow.name}
            onChange={(e) => setWorkflow({ ...workflow, name: e.target.value })}
          />
          <TextField
            margin="dense"
            label="Description"
            fullWidth
            multiline
            rows={4}
            value={workflow.description}
            onChange={(e) => setWorkflow({ ...workflow, description: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsSaveDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} color="primary">Save</Button>
        </DialogActions>
      </Dialog>

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