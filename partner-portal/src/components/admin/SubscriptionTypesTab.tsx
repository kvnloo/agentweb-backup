import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormGroup,
  IconButton,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  Alert,
  CircularProgress,
  Chip,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

interface SubscriptionType {
  name: string;
  allowedPages: string[];
  allowedFunctionCalls: string[];
}

interface AvailableFunctionCall {
  name: string;
  description: string;
}

interface CustomerPortalPage {
  path: string;
  label: string;
  description?: string;
}

const SubscriptionTypesTab: React.FC = () => {
  const { token } = useAuth();
  const [subscriptionTypes, setSubscriptionTypes] = useState<SubscriptionType[]>([]);
  const [availableFunctionCalls, setAvailableFunctionCalls] = useState<AvailableFunctionCall[]>([]);
  const [availablePages, setAvailablePages] = useState<CustomerPortalPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<SubscriptionType | null>(null);
  const [formData, setFormData] = useState<SubscriptionType>({
    name: '',
    allowedPages: [],
    allowedFunctionCalls: [],
  });

  useEffect(() => {
    loadSubscriptionTypes();
    loadAvailableFunctionCalls();
    loadAvailablePages();
  }, []);

  // Update formData when availableFunctionCalls or availablePages loads (for new types or when editing types with "*")
  useEffect(() => {
    if (editDialogOpen) {
      if (!editingType) {
        // If creating new type, update formData when data loads
        if (availableFunctionCalls.length > 0 && availablePages.length > 0) {
          setFormData((prev) => ({
            ...prev,
            allowedPages: availablePages.map((p) => p.path),
            allowedFunctionCalls: availableFunctionCalls.map((f) => f.name),
          }));
        }
      } else if (
        editingType.allowedFunctionCalls.includes('*') ||
        editingType.allowedFunctionCalls.length === 0
      ) {
        // If editing a type that had "*" and function calls just loaded, update formData
        if (availableFunctionCalls.length > 0) {
          setFormData((prev) => ({
            ...prev,
            allowedFunctionCalls: availableFunctionCalls.map((f) => f.name),
          }));
        }
      }
      if (
        editingType &&
        (editingType.allowedPages.includes('*') || editingType.allowedPages.length === 0)
      ) {
        // If editing a type that had "*" for pages and pages just loaded, update formData
        if (availablePages.length > 0) {
          setFormData((prev) => ({
            ...prev,
            allowedPages: availablePages.map((p) => p.path),
          }));
        }
      }
    }
  }, [availableFunctionCalls, availablePages, editDialogOpen, editingType]);

  const loadSubscriptionTypes = async () => {
    try {
      setLoading(true);
      const response = await axios.get(buildApiUrl('/api/admin/subscription-types'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSubscriptionTypes(response.data);
      setError('');
    } catch (err: any) {
      console.error('Error loading subscription types:', err);
      setError(err.response?.data?.message || 'Failed to load subscription types');
    } finally {
      setLoading(false);
    }
  };

  const loadAvailableFunctionCalls = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/agent-mode/function-calls'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.data && response.data.functionCalls) {
        // Filter out work plan management functions
        const workPlanFunctions = ['create_work_plan', 'modify_work_plan', 'set_work_plan_status'];
        const filtered = response.data.functionCalls.filter(
          (func: AvailableFunctionCall) => !workPlanFunctions.includes(func.name)
        );
        setAvailableFunctionCalls(filtered);
      }
    } catch (error) {
      console.error('Error loading available function calls:', error);
    }
  };

  const loadAvailablePages = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/subscription/customer-portal-pages'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.data && response.data.pages) {
        // Pages are already in the correct format (without /marketing prefix)
        setAvailablePages(response.data.pages);
      }
    } catch (error) {
      console.error('Error loading available pages:', error);
    }
  };

  const handleOpenEditDialog = (type?: SubscriptionType) => {
    if (type) {
      setEditingType(type);
      // Expand "*" to all actual pages/function calls for editing
      // Normalize paths: remove /marketing prefix if present
      const normalizedPages = type.allowedPages.includes('*') || type.allowedPages.length === 0
        ? availablePages.map((p) => p.path)
        : type.allowedPages.map((page: string) => {
            if (page.startsWith('/marketing/')) {
              return page.replace('/marketing', '');
            }
            return page;
          });
      
      const expandedData: SubscriptionType = {
        name: type.name,
        allowedPages: normalizedPages,
        allowedFunctionCalls: type.allowedFunctionCalls.includes('*') || type.allowedFunctionCalls.length === 0
          ? availableFunctionCalls.map((f) => f.name)
          : type.allowedFunctionCalls,
      };
      setFormData(expandedData);
    } else {
      setEditingType(null);
      // When creating new, start with all pages and function calls selected
      setFormData({
        name: '',
        allowedPages: availablePages.map((p) => p.path),
        allowedFunctionCalls: availableFunctionCalls.map((f) => f.name),
      });
    }
    setEditDialogOpen(true);
  };

  const handleCloseEditDialog = () => {
    setEditDialogOpen(false);
    setEditingType(null);
    setFormData({
      name: '',
      allowedPages: [],
      allowedFunctionCalls: [],
    });
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      setError('Subscription type name is required');
      return;
    }

    try {
      setLoading(true);
      setError('');
      
      // Convert all selected items back to "*" if all are selected
      const dataToSave: SubscriptionType = {
        name: formData.name,
        allowedPages:
          formData.allowedPages.length === availablePages.length && availablePages.length > 0
            ? ['*']
            : formData.allowedPages,
        allowedFunctionCalls:
          formData.allowedFunctionCalls.length === availableFunctionCalls.length && availableFunctionCalls.length > 0
            ? ['*']
            : formData.allowedFunctionCalls,
      };
      
      let updatedTypes = [...subscriptionTypes];
      if (editingType) {
        // Update existing
        const index = updatedTypes.findIndex((t) => t.name === editingType.name);
        if (index >= 0) {
          updatedTypes[index] = dataToSave;
        }
      } else {
        // Add new
        updatedTypes.push(dataToSave);
      }

      await axios.post(
        buildApiUrl('/api/admin/subscription-types'),
        { subscriptionTypes: updatedTypes },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setSuccess(editingType ? 'Subscription type updated successfully' : 'Subscription type created successfully');
      await loadSubscriptionTypes();
      handleCloseEditDialog();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      console.error('Error saving subscription type:', err);
      setError(err.response?.data?.message || 'Failed to save subscription type');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (typeName: string) => {
    if (!window.confirm(`Are you sure you want to delete subscription type "${typeName}"?`)) {
      return;
    }

    try {
      setLoading(true);
      setError('');
      
      const updatedTypes = subscriptionTypes.filter((t) => t.name !== typeName);
      await axios.post(
        buildApiUrl('/api/admin/subscription-types'),
        { subscriptionTypes: updatedTypes },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setSuccess('Subscription type deleted successfully');
      await loadSubscriptionTypes();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      console.error('Error deleting subscription type:', err);
      setError(err.response?.data?.message || 'Failed to delete subscription type');
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePage = (pagePath: string) => {
    const isSelected = formData.allowedPages.includes(pagePath);
    if (isSelected) {
      setFormData({
        ...formData,
        allowedPages: formData.allowedPages.filter((p) => p !== pagePath),
      });
    } else {
      setFormData({
        ...formData,
        allowedPages: [...formData.allowedPages, pagePath],
      });
    }
  };

  const handleToggleAllPages = () => {
    if (formData.allowedPages.length === availablePages.length) {
      setFormData({ ...formData, allowedPages: [] });
    } else {
      setFormData({ ...formData, allowedPages: availablePages.map((p) => p.path) });
    }
  };

  const handleToggleFunctionCall = (functionName: string) => {
    const isSelected = formData.allowedFunctionCalls.includes(functionName);
    if (isSelected) {
      setFormData({
        ...formData,
        allowedFunctionCalls: formData.allowedFunctionCalls.filter((f) => f !== functionName),
      });
    } else {
      setFormData({
        ...formData,
        allowedFunctionCalls: [...formData.allowedFunctionCalls, functionName],
      });
    }
  };

  const handleToggleAllFunctionCalls = () => {
    if (formData.allowedFunctionCalls.length === availableFunctionCalls.length) {
      setFormData({ ...formData, allowedFunctionCalls: [] });
    } else {
      setFormData({
        ...formData,
        allowedFunctionCalls: availableFunctionCalls.map((f) => f.name),
      });
    }
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5">Subscription Types</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => handleOpenEditDialog()}
          disabled={loading}
        >
          Add Subscription Type
        </Button>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Configure subscription types for customer portal users. If no subscription types are defined, the default "Basic" type will be used, allowing access to all pages and function calls.
      </Typography>

      {loading && !subscriptionTypes.length ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Allowed Pages</TableCell>
                <TableCell>Allowed Function Calls</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {subscriptionTypes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} align="center">
                    <Typography variant="body2" color="text.secondary">
                      No subscription types defined. Using default "Basic" type.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                subscriptionTypes.map((type) => (
                  <TableRow key={type.name}>
                    <TableCell>
                      <Typography variant="body1" fontWeight="medium">
                        {type.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {type.allowedPages.includes('*') || type.allowedPages.length === 0 ? (
                        <Chip label="All Pages" color="primary" size="small" />
                      ) : (
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {type.allowedPages.slice(0, 3).map((page) => {
                            // Normalize page path by removing /marketing prefix
                            const normalizedPage = page.startsWith('/marketing/') 
                              ? page.replace('/marketing', '') 
                              : page;
                            const pageInfo = availablePages.find((p) => p.path === normalizedPage);
                            return (
                              <Chip
                                key={page}
                                label={pageInfo?.label || normalizedPage}
                                size="small"
                                variant="outlined"
                              />
                            );
                          })}
                          {type.allowedPages.length > 3 && (
                            <Chip
                              label={`+${type.allowedPages.length - 3} more`}
                              size="small"
                              variant="outlined"
                            />
                          )}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell>
                      {type.allowedFunctionCalls.includes('*') ||
                      type.allowedFunctionCalls.length === 0 ? (
                        <Chip label="All Functions" color="primary" size="small" />
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          {type.allowedFunctionCalls.length} function
                          {type.allowedFunctionCalls.length !== 1 ? 's' : ''}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <IconButton
                        size="small"
                        onClick={() => handleOpenEditDialog(type)}
                        disabled={loading}
                      >
                        <EditIcon />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => handleDelete(type.name)}
                        disabled={loading}
                        color="error"
                      >
                        <DeleteIcon />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={editDialogOpen} onClose={handleCloseEditDialog} maxWidth="md" fullWidth>
        <DialogTitle>
          {editingType ? 'Edit Subscription Type' : 'Create Subscription Type'}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            <TextField
              label="Subscription Type Name"
              fullWidth
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              sx={{ mb: 3 }}
              disabled={!!editingType}
              helperText={editingType ? 'Name cannot be changed after creation' : ''}
            />

            <Typography variant="h6" gutterBottom>
              Allowed Pages
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select which customer portal pages users with this subscription type can access. Note: Agent Mode, User Guide, and Settings are always available.
            </Typography>
            <FormGroup>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={formData.allowedPages.length === availablePages.length && availablePages.length > 0}
                    indeterminate={
                      formData.allowedPages.length > 0 &&
                      formData.allowedPages.length < availablePages.length
                    }
                    onChange={handleToggleAllPages}
                    disabled={availablePages.length === 0}
                  />
                }
                label="Select All Pages"
              />
              {availablePages.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                  Loading pages...
                </Typography>
              ) : (
                availablePages.map((page) => (
                  <FormControlLabel
                    key={page.path}
                    control={
                      <Checkbox
                        checked={formData.allowedPages.includes(page.path)}
                        onChange={() => handleTogglePage(page.path)}
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          {page.label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                          {page.path}
                        </Typography>
                        {page.description && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {page.description}
                          </Typography>
                        )}
                      </Box>
                    }
                  />
                ))
              )}
            </FormGroup>

            <Typography variant="h6" gutterBottom sx={{ mt: 4 }}>
              Allowed Function Calls
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select which Agent Mode function calls users with this subscription type can access.
            </Typography>
            <Box
              sx={{
                maxHeight: 300,
                overflowY: 'auto',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                p: 2,
              }}
            >
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={
                        formData.allowedFunctionCalls.length === availableFunctionCalls.length
                      }
                      indeterminate={
                        formData.allowedFunctionCalls.length > 0 &&
                        formData.allowedFunctionCalls.length < availableFunctionCalls.length
                      }
                      onChange={handleToggleAllFunctionCalls}
                    />
                  }
                  label="Select All Function Calls"
                />
                {availableFunctionCalls.map((func) => (
                  <FormControlLabel
                    key={func.name}
                    control={
                      <Checkbox
                        checked={formData.allowedFunctionCalls.includes(func.name)}
                        onChange={() => handleToggleFunctionCall(func.name)}
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          {func.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {func.description}
                        </Typography>
                      </Box>
                    }
                  />
                ))}
              </FormGroup>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseEditDialog} startIcon={<CancelIcon />}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            variant="contained"
            startIcon={<SaveIcon />}
            disabled={loading}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default SubscriptionTypesTab;
