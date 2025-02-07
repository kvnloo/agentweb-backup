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
  MarkerType
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

interface WorkflowData {
  id: string;
  name: string;
  description: string;
  nodes: Node[];
  edges: Edge[];
}

const nodeTypes = {
  task: TaskIcon,
  loop: LoopIcon,
  condition: BranchIcon
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
  
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'error'>('success');

  useEffect(() => {
    if (id && id !== 'new') {
      // TODO: Fetch workflow data from API
      const mockWorkflow: WorkflowData = {
        id,
        name: 'Sample Workflow',
        description: 'A sample workflow',
        nodes: [
          {
            id: '1',
            type: 'task',
            position: { x: 250, y: 100 },
            data: { label: 'Start Task' }
          },
          {
            id: '2',
            type: 'task',
            position: { x: 250, y: 200 },
            data: { label: 'End Task' }
          }
        ],
        edges: [
          {
            id: 'e1-2',
            source: '1',
            target: '2',
            markerEnd: { type: MarkerType.ArrowClosed }
          }
        ]
      };
      setWorkflow(mockWorkflow);
      setNodes(mockWorkflow.nodes);
      setEdges(mockWorkflow.edges);
    }
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
    const newNode: Node = {
      id: `${Date.now()}`,
      type,
      position: { x: 250, y: 100 },
      data: { label: `New ${type}` }
    };
    setNodes((nds) => [...nds, newNode]);
    setIsDrawerOpen(false);
  };

  const handleNodeClick = (event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setIsSettingsOpen(true);
  };

  const handleSave = () => {
    // TODO: Implement save workflow
    setShowSnackbar(true);
    setSnackbarMessage('Workflow saved successfully');
    setSnackbarSeverity('success');
    setIsSaveDialogOpen(false);
  };

  const handleRun = () => {
    // TODO: Implement run workflow
    setShowSnackbar(true);
    setSnackbarMessage('Workflow started');
    setSnackbarSeverity('success');
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
      <Box sx={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
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
            {Object.entries(nodeTypes).map(([type, Icon]) => (
              <ListItem key={type} disablePadding>
                <ListItemButton onClick={() => handleAddNode(type)}>
                  <ListItemIcon>
                    <Icon />
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
        onClose={() => setIsSettingsOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Node Settings</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
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
          {/* Add more node-specific settings here */}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsSettingsOpen(false)}>Close</Button>
          <Button onClick={() => setIsSettingsOpen(false)} color="primary">
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