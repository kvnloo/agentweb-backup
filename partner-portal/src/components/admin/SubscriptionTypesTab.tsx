import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  Alert,
  CircularProgress,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
  CheckCircle as CheckCircleIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Lock as LockIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

type PageAccessState = 'allowed' | 'locked' | 'hidden';

interface SubscriptionType {
  name: string;
  allowedPages: string[];
  hiddenPages?: string[];
  allowedSkills: string[];
  allowedConnectedAccounts?: string[];
  monthlyTokenAllowance?: number | null;
}

const AVAILABLE_CONNECTED_ACCOUNTS = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'unipile', label: 'LinkedIn Outreach' },
  { id: 'meta', label: 'Meta Marketing' },
  { id: 'instagram', label: 'Instagram Business' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'fathom', label: 'Fathom' },
  { id: 'hubspot', label: 'HubSpot' },
  { id: 'attio', label: 'Attio' },
  { id: 'google_ads', label: 'Google Ads' },
  { id: 'google_drive', label: 'Google Drive' },
];

interface AvailableSkill {
  skillId: string;
  name: string;
  description: string;
  toolNames: string[];
}

interface CustomerPortalPage {
  path: string;
  label: string;
  description?: string;
}

const SubscriptionTypesTab: React.FC = () => {
  const { token } = useAuth();
  const [subscriptionTypes, setSubscriptionTypes] = useState<SubscriptionType[]>([]);
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([]);
  const [availablePages, setAvailablePages] = useState<CustomerPortalPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<SubscriptionType | null>(null);
  const [formData, setFormData] = useState<SubscriptionType>({
    name: '',
    allowedPages: [],
    hiddenPages: [],
    allowedSkills: [],
    allowedConnectedAccounts: AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id),
    monthlyTokenAllowance: null,
  });
  const [tokenAllowanceInput, setTokenAllowanceInput] = useState('');
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadSubscriptionTypes();
    loadAvailableSkills();
    loadAvailablePages();
  }, []);

  // Update formData when availableSkills or availablePages loads (for new types or when editing types with "*")
  useEffect(() => {
    if (editDialogOpen) {
      if (!editingType) {
        // If creating new type, update formData when data loads
        if (availableSkills.length > 0 && availablePages.length > 0) {
          setFormData((prev) => ({
            ...prev,
            allowedPages: availablePages.map((p) => p.path),
            hiddenPages: [],
            allowedSkills: availableSkills.map((s) => s.skillId),
          }));
        }
      } else if (
        editingType.allowedSkills.includes('*') ||
        editingType.allowedSkills.length === 0
      ) {
        // If editing a type that had "*" and skills just loaded, update formData
        if (availableSkills.length > 0) {
          setFormData((prev) => ({
            ...prev,
            allowedSkills: availableSkills.map((s) => s.skillId),
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
  }, [availableSkills, availablePages, editDialogOpen, editingType]);

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

  const loadAvailableSkills = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/admin/available-skills'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.data && Array.isArray(response.data)) {
        setAvailableSkills(response.data);
      }
    } catch (error) {
      console.error('Error loading available skills:', error);
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
      // Expand "*" to all actual pages/skills for editing
      // Normalize paths: remove /marketing prefix if present
      const normalizedPages = type.allowedPages.includes('*') || type.allowedPages.length === 0
        ? availablePages.map((p) => p.path)
        : type.allowedPages.map((page: string) => {
            if (page.startsWith('/marketing/')) {
              return page.replace('/marketing', '');
            }
            return page;
          });

      const allAccountIds = AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id);
      const expandedConnectedAccounts =
        !type.allowedConnectedAccounts ||
        type.allowedConnectedAccounts.includes('*') ||
        type.allowedConnectedAccounts.length === 0
          ? allAccountIds
          : type.allowedConnectedAccounts;

      const expandedData: SubscriptionType = {
        name: type.name,
        allowedPages: normalizedPages,
        hiddenPages: type.hiddenPages || [],
        allowedSkills: type.allowedSkills.includes('*') || type.allowedSkills.length === 0
          ? availableSkills.map((s) => s.skillId)
          : type.allowedSkills,
        allowedConnectedAccounts: expandedConnectedAccounts,
        monthlyTokenAllowance: type.monthlyTokenAllowance ?? null,
      };
      setFormData(expandedData);
      setTokenAllowanceInput(type.monthlyTokenAllowance != null ? String(type.monthlyTokenAllowance) : '');
    } else {
      setEditingType(null);
      // When creating new, start with all pages, skills, and platforms selected
      setFormData({
        name: '',
        allowedPages: availablePages.map((p) => p.path),
        hiddenPages: [],
        allowedSkills: availableSkills.map((s) => s.skillId),
        allowedConnectedAccounts: AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id),
        monthlyTokenAllowance: null,
      });
      setTokenAllowanceInput('');
    }
    setExpandedSkills(new Set());
    setEditDialogOpen(true);
  };

  const handleCloseEditDialog = () => {
    setEditDialogOpen(false);
    setEditingType(null);
    setFormData({
      name: '',
      allowedPages: [],
      hiddenPages: [],
      allowedSkills: [],
      allowedConnectedAccounts: AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id),
      monthlyTokenAllowance: null,
    });
    setTokenAllowanceInput('');
    setExpandedSkills(new Set());
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      setError('Subscription type name is required');
      return;
    }

    try {
      setLoading(true);
      setError('');

      // Parse token allowance from input
      const parsedAllowance = tokenAllowanceInput.trim() === ''
        ? null
        : parseInt(tokenAllowanceInput.replace(/,/g, ''), 10);
      if (parsedAllowance !== null && (isNaN(parsedAllowance) || parsedAllowance < 0)) {
        setError('Monthly token allowance must be a positive number or empty for unlimited');
        return;
      }

      // Convert all selected items back to "*" if all are selected
      const dataToSave: SubscriptionType = {
        name: formData.name,
        allowedPages: formData.allowedPages,
        hiddenPages: formData.hiddenPages || [],
        allowedSkills:
          formData.allowedSkills.length === availableSkills.length && availableSkills.length > 0
            ? ['*']
            : formData.allowedSkills,
        allowedConnectedAccounts:
          (formData.allowedConnectedAccounts?.length ?? 0) === AVAILABLE_CONNECTED_ACCOUNTS.length
            ? ['*']
            : formData.allowedConnectedAccounts || [],
        monthlyTokenAllowance: parsedAllowance,
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

  const getPageAccessState = (pagePath: string): PageAccessState => {
    if (formData.allowedPages.includes(pagePath)) return 'allowed';
    if ((formData.hiddenPages || []).includes(pagePath)) return 'hidden';
    return 'locked';
  };

  const handlePageAccessChange = (pagePath: string, newState: PageAccessState) => {
    setFormData({
      ...formData,
      allowedPages: newState === 'allowed'
        ? [...formData.allowedPages.filter((p) => p !== pagePath), pagePath]
        : formData.allowedPages.filter((p) => p !== pagePath),
      hiddenPages: newState === 'hidden'
        ? [...(formData.hiddenPages || []).filter((p) => p !== pagePath), pagePath]
        : (formData.hiddenPages || []).filter((p) => p !== pagePath),
    });
  };

  const handleToggleAllPages = () => {
    if (formData.allowedPages.length === availablePages.length) {
      setFormData({ ...formData, allowedPages: [], hiddenPages: [] });
    } else {
      setFormData({ ...formData, allowedPages: availablePages.map((p) => p.path), hiddenPages: [] });
    }
  };

  const handleToggleSkill = (skillId: string) => {
    const isSelected = formData.allowedSkills.includes(skillId);
    if (isSelected) {
      setFormData({
        ...formData,
        allowedSkills: formData.allowedSkills.filter((s) => s !== skillId),
      });
    } else {
      setFormData({
        ...formData,
        allowedSkills: [...formData.allowedSkills, skillId],
      });
    }
  };

  const handleToggleAllSkills = () => {
    if (formData.allowedSkills.length === availableSkills.length) {
      setFormData({ ...formData, allowedSkills: [] });
    } else {
      setFormData({
        ...formData,
        allowedSkills: availableSkills.map((s) => s.skillId),
      });
    }
  };

  const handleToggleConnectedAccount = (accountId: string) => {
    const current = formData.allowedConnectedAccounts || [];
    const isSelected = current.includes(accountId);
    setFormData({
      ...formData,
      allowedConnectedAccounts: isSelected
        ? current.filter((a) => a !== accountId)
        : [...current, accountId],
    });
  };

  const handleToggleAllConnectedAccounts = () => {
    const allIds = AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id);
    if ((formData.allowedConnectedAccounts?.length ?? 0) === allIds.length) {
      setFormData({ ...formData, allowedConnectedAccounts: [] });
    } else {
      setFormData({ ...formData, allowedConnectedAccounts: allIds });
    }
  };

  const toggleSkillExpanded = (skillId: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
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
        Configure subscription types for customer portal users. If no subscription types are defined, the default "Basic" type will be used, allowing access to all pages and skills.
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
                <TableCell>Monthly Token Allowance</TableCell>
                <TableCell>Allowed Pages</TableCell>
                <TableCell>Allowed Skills</TableCell>
                <TableCell>Connected Accounts</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {subscriptionTypes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center">
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
                      <Typography variant="body2">
                        {type.monthlyTokenAllowance != null
                          ? type.monthlyTokenAllowance.toLocaleString()
                          : 'Unlimited'}
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
                      {type.allowedSkills.includes('*') ||
                      type.allowedSkills.length === 0 ? (
                        <Chip label="All Skills" color="primary" size="small" />
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          {type.allowedSkills.length} skill
                          {type.allowedSkills.length !== 1 ? 's' : ''}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {!type.allowedConnectedAccounts ||
                      type.allowedConnectedAccounts.includes('*') ||
                      type.allowedConnectedAccounts.length === AVAILABLE_CONNECTED_ACCOUNTS.length ? (
                        <Chip label="All Platforms" color="primary" size="small" />
                      ) : type.allowedConnectedAccounts.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          None
                        </Typography>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          {type.allowedConnectedAccounts.length} platform
                          {type.allowedConnectedAccounts.length !== 1 ? 's' : ''}
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

            <TextField
              label="Monthly Token Allowance"
              fullWidth
              value={tokenAllowanceInput}
              onChange={(e) => setTokenAllowanceInput(e.target.value)}
              sx={{ mb: 3 }}
              placeholder="Leave empty for unlimited"
              helperText="Maximum tokens per month for this subscription type. Leave empty for unlimited usage."
              type="text"
              inputProps={{ inputMode: 'numeric', pattern: '[0-9,]*' }}
            />

            <Typography variant="h6" gutterBottom>
              Page Access
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Set access level for each page. Note: Agent Mode, User Guide, and Settings are always available.
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                <Typography variant="caption">Allowed — user can access</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <LockIcon sx={{ fontSize: 16, color: 'warning.main' }} />
                <Typography variant="caption">Locked — shown with upgrade prompt</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <VisibilityOffIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                <Typography variant="caption">Hidden — not shown at all</Typography>
              </Box>
            </Box>
            <Box sx={{ mb: 1 }}>
              <Button
                size="small"
                onClick={handleToggleAllPages}
                disabled={availablePages.length === 0}
              >
                {formData.allowedPages.length === availablePages.length && availablePages.length > 0
                  ? 'Set All Locked'
                  : 'Set All Allowed'}
              </Button>
            </Box>
            {availablePages.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                Loading pages...
              </Typography>
            ) : (
              <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
                {availablePages.map((page, idx) => {
                  const state = getPageAccessState(page.path);
                  return (
                    <Box
                      key={page.path}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        px: 2,
                        py: 1,
                        borderBottom: idx < availablePages.length - 1 ? '1px solid' : 'none',
                        borderColor: 'divider',
                        gap: 2,
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" fontWeight="medium">
                          {page.label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                          {page.path}
                        </Typography>
                      </Box>
                      <ToggleButtonGroup
                        value={state}
                        exclusive
                        size="small"
                        onChange={(_e, val) => { if (val !== null) handlePageAccessChange(page.path, val as PageAccessState); }}
                        aria-label={`Access for ${page.label}`}
                      >
                        <Tooltip title="Allowed — user can access this page">
                          <ToggleButton value="allowed" aria-label="allowed" sx={{ px: 1.5 }}>
                            <CheckCircleIcon sx={{ fontSize: 16, mr: 0.5, color: state === 'allowed' ? 'success.main' : 'inherit' }} />
                            <Typography variant="caption">Allow</Typography>
                          </ToggleButton>
                        </Tooltip>
                        <Tooltip title="Locked — shown in sidebar with lock icon and upgrade prompt">
                          <ToggleButton value="locked" aria-label="locked" sx={{ px: 1.5 }}>
                            <LockIcon sx={{ fontSize: 16, mr: 0.5, color: state === 'locked' ? 'warning.main' : 'inherit' }} />
                            <Typography variant="caption">Lock</Typography>
                          </ToggleButton>
                        </Tooltip>
                        <Tooltip title="Hidden — not shown in sidebar at all">
                          <ToggleButton value="hidden" aria-label="hidden" sx={{ px: 1.5 }}>
                            <VisibilityOffIcon sx={{ fontSize: 16, mr: 0.5, color: state === 'hidden' ? 'text.disabled' : 'inherit' }} />
                            <Typography variant="caption">Hide</Typography>
                          </ToggleButton>
                        </Tooltip>
                      </ToggleButtonGroup>
                    </Box>
                  );
                })}
              </Box>
            )}

            <Typography variant="h6" gutterBottom sx={{ mt: 4 }}>
              Allowed Skills
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select which Agent Mode skills users with this subscription type can access. Each skill groups related tools together.
            </Typography>
            <Box
              sx={{
                maxHeight: 400,
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
                        formData.allowedSkills.length === availableSkills.length && availableSkills.length > 0
                      }
                      indeterminate={
                        formData.allowedSkills.length > 0 &&
                        formData.allowedSkills.length < availableSkills.length
                      }
                      onChange={handleToggleAllSkills}
                      disabled={availableSkills.length === 0}
                    />
                  }
                  label="Select All Skills"
                />
                {availableSkills.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                    Loading skills...
                  </Typography>
                ) : (
                  availableSkills.map((skill) => (
                    <Box key={skill.skillId}>
                      <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={formData.allowedSkills.includes(skill.skillId)}
                              onChange={() => handleToggleSkill(skill.skillId)}
                            />
                          }
                          label={
                            <Box>
                              <Typography variant="body2" fontWeight="medium">
                                {skill.name}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {skill.description}
                              </Typography>
                            </Box>
                          }
                          sx={{ flex: 1 }}
                        />
                        {skill.toolNames.length > 0 && (
                          <IconButton
                            size="small"
                            onClick={() => toggleSkillExpanded(skill.skillId)}
                            sx={{ ml: 1 }}
                          >
                            {expandedSkills.has(skill.skillId) ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                          </IconButton>
                        )}
                      </Box>
                      <Collapse in={expandedSkills.has(skill.skillId)}>
                        <Box sx={{ ml: 4, mb: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {skill.toolNames.map((toolName) => (
                            <Chip
                              key={toolName}
                              label={toolName}
                              size="small"
                              variant="outlined"
                              sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}
                            />
                          ))}
                        </Box>
                      </Collapse>
                    </Box>
                  ))
                )}
              </FormGroup>
            </Box>

            <Typography variant="h6" gutterBottom sx={{ mt: 4 }}>
              Allowed Connected Accounts
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select which social media platforms users with this subscription type can connect.
            </Typography>
            <FormGroup>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={
                      (formData.allowedConnectedAccounts?.length ?? 0) === AVAILABLE_CONNECTED_ACCOUNTS.length
                    }
                    indeterminate={
                      (formData.allowedConnectedAccounts?.length ?? 0) > 0 &&
                      (formData.allowedConnectedAccounts?.length ?? 0) < AVAILABLE_CONNECTED_ACCOUNTS.length
                    }
                    onChange={handleToggleAllConnectedAccounts}
                  />
                }
                label="Select All Platforms"
              />
              {AVAILABLE_CONNECTED_ACCOUNTS.map((account) => (
                <FormControlLabel
                  key={account.id}
                  control={
                    <Checkbox
                      checked={formData.allowedConnectedAccounts?.includes(account.id) ?? false}
                      onChange={() => handleToggleConnectedAccount(account.id)}
                    />
                  }
                  label={account.label}
                />
              ))}
            </FormGroup>
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
