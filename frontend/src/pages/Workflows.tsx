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
  TextField,
  CircularProgress,
  Paper,
  Alert,
  Snackbar
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'error'>('success');

  useEffect(() => {
    const fetchWorkflows = async () => {
      try {
        setLoading(true);
        setError(null);
        const baseUrl = import.meta.env.VITE_API_URL || '';
        const response = await fetch(`${baseUrl}/api/workflows`, {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
          },
          credentials: 'include'
        });

        if (!response.ok) {
          throw new Error('Failed to fetch workflows');
        }

        const data = await response.json();
        setWorkflows(data.map((workflow: any) => ({
          id: workflow.workflowId,
          name: workflow.name,
          description: workflow.description,
          status: workflow.status || 'active',
          taskCount: workflow.nodes?.length || 0,
          lastRun: workflow.lastRun,
          createdAt: workflow.createdAt
        })));
      } catch (error) {
        console.error('Error fetching workflows:', error);
        setError(error instanceof Error ? error.message : 'Failed to fetch workflows');
      } finally {
        setLoading(false);
      }
    };

    fetchWorkflows();
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

  const handleDeleteWorkflow = async () => {
    try {
      if (!selectedWorkflow) return;

      const baseUrl = import.meta.env.VITE_API_URL || '';
      const response = await fetch(`${baseUrl}/api/workflows/${selectedWorkflow.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to delete workflow');
      }

      // Remove the workflow from the local state
      setWorkflows(workflows.filter(w => w.id !== selectedWorkflow.id));
      
      // Show success message
      setError(null);
      setSnackbarMessage('Workflow deleted successfully');
      setSnackbarSeverity('success');
      setShowSnackbar(true);
    } catch (error) {
      console.error('Error deleting workflow:', error);
      setError(error instanceof Error ? error.message : 'Failed to delete workflow');
    } finally {
      setIsDeleteDialogOpen(false);
      handleMenuClose();
    }
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

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      ) : workflows.length === 0 ? (
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            No workflows found
          </Typography>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={handleCreateWorkflow}
          >
            Create your first workflow
          </Button>
        </Paper>
      ) : (
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
      )}

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

      <Dialog open={isDeleteDialogOpen} onClose={() => setIsDeleteDialogOpen(false)}>
        <DialogTitle>Delete Workflow</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete "{selectedWorkflow?.name}"? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDeleteWorkflow} color="error" variant="contained">
            Delete
          </Button>
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