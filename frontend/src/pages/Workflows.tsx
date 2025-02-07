import React, { useState, useEffect } from 'react';
import { 
  Box, 
  Button, 
  Typography, 
  Card, 
  CardContent, 
  Grid,
  IconButton,
  Chip,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField
} from '@mui/material';
import { 
  Add as AddIcon,
  MoreVert as MoreVertIcon,
  PlayArrow as PlayIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  ContentCopy as CloneIcon
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';

interface Workflow {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'draft' | 'archived';
  taskCount: number;
  lastRun?: string;
  createdAt: string;
}

export default function Workflows() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    // TODO: Fetch workflows from API
    const mockWorkflows: Workflow[] = [
      {
        id: '1',
        name: 'Daily Report Generation',
        description: 'Generates and sends daily reports',
        status: 'active',
        taskCount: 3,
        lastRun: '2024-02-06T10:00:00',
        createdAt: '2024-01-01T00:00:00'
      },
      // Add more mock data as needed
    ];
    setWorkflows(mockWorkflows);
  }, []);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, workflow: Workflow) => {
    setAnchorEl(event.currentTarget);
    setSelectedWorkflow(workflow);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setSelectedWorkflow(null);
  };

  const handleCreateWorkflow = () => {
    navigate('/workflows/new');
  };

  const handleEditWorkflow = (workflowId: string) => {
    navigate(`/workflows/${workflowId}/edit`);
    handleMenuClose();
  };

  const handleRunWorkflow = (workflowId: string) => {
    // TODO: Implement workflow execution
    console.log('Running workflow:', workflowId);
    handleMenuClose();
  };

  const handleDeleteWorkflow = () => {
    // TODO: Implement workflow deletion
    console.log('Deleting workflow:', selectedWorkflow?.id);
    setIsDeleteDialogOpen(false);
    handleMenuClose();
  };

  const handleCloneWorkflow = () => {
    // TODO: Implement workflow cloning
    console.log('Cloning workflow:', selectedWorkflow?.id);
    handleMenuClose();
  };

  const handleRenameWorkflow = () => {
    // TODO: Implement workflow renaming
    console.log('Renaming workflow:', selectedWorkflow?.id, 'to:', newName);
    setIsRenameDialogOpen(false);
    setNewName('');
    handleMenuClose();
  };

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h4">Workflows</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleCreateWorkflow}
        >
          Create Workflow
        </Button>
      </Box>

      <Grid container spacing={3}>
        {workflows.map((workflow) => (
          <Grid item xs={12} sm={6} md={4} key={workflow.id}>
            <Card>
              <CardContent>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Typography variant="h6" component="div" sx={{ mb: 1 }}>
                    {workflow.name}
                  </Typography>
                  <IconButton onClick={(e) => handleMenuOpen(e, workflow)}>
                    <MoreVertIcon />
                  </IconButton>
                </Box>
                <Typography color="text.secondary" sx={{ mb: 1 }}>
                  {workflow.description}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                  <Chip
                    label={`${workflow.taskCount} tasks`}
                    size="small"
                  />
                  <Chip
                    label={workflow.status}
                    size="small"
                    color={workflow.status === 'active' ? 'success' : 'default'}
                  />
                </Box>
                {workflow.lastRun && (
                  <Typography variant="body2" color="text.secondary">
                    Last run: {new Date(workflow.lastRun).toLocaleString()}
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleMenuClose}
      >
        <MenuItem onClick={() => selectedWorkflow && handleRunWorkflow(selectedWorkflow.id)}>
          <PlayIcon sx={{ mr: 1 }} /> Run Now
        </MenuItem>
        <MenuItem onClick={() => selectedWorkflow && handleEditWorkflow(selectedWorkflow.id)}>
          <EditIcon sx={{ mr: 1 }} /> Edit
        </MenuItem>
        <MenuItem onClick={() => setIsRenameDialogOpen(true)}>
          <EditIcon sx={{ mr: 1 }} /> Rename
        </MenuItem>
        <MenuItem onClick={handleCloneWorkflow}>
          <CloneIcon sx={{ mr: 1 }} /> Clone
        </MenuItem>
        <MenuItem onClick={() => setIsDeleteDialogOpen(true)} sx={{ color: 'error.main' }}>
          <DeleteIcon sx={{ mr: 1 }} /> Delete
        </MenuItem>
      </Menu>

      <Dialog open={isDeleteDialogOpen} onClose={() => setIsDeleteDialogOpen(false)}>
        <DialogTitle>Delete Workflow</DialogTitle>
        <DialogContent>
          Are you sure you want to delete "{selectedWorkflow?.name}"? This action cannot be undone.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDeleteWorkflow} color="error">Delete</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={isRenameDialogOpen} onClose={() => setIsRenameDialogOpen(false)}>
        <DialogTitle>Rename Workflow</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="New Name"
            fullWidth
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsRenameDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleRenameWorkflow} color="primary">Rename</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
} 