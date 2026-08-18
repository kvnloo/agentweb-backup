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
  MenuItem,
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
  allowedFeatures?: string[];
  monthlyTokenAllowance?: number | null;
  monthlyCostAllowance?: number | null;
  llmUsagePolicy?: {
    version: string;
    enforcementState: 'observe' | 'hard_only' | 'enforce';
    optimizationCostThresholdMicroUsd: number;
    hardCostThresholdMicroUsd: number;
    optimizedModelIds: string[];
    optimizedDefaultModel: string;
    /** Absent = follow the platform default rather than a value pinned here. */
    alertUsagePercentThreshold?: number;
    alertOnForecastShortfall?: boolean;
  };
  llmUsageTopUp?: {
    enabled: boolean;
    minimumMarkupBps: number;
    packages: Array<{
      id: string;
      label: string;
      priceCents: number;
      usageCreditMicroUsd: number;
      active: boolean;
    }>;
  };
}

interface AvailableFeature {
  id: string;
  label: string;
  description: string;
}

const AVAILABLE_CONNECTED_ACCOUNTS = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'unipile', label: 'LinkedIn Outreach' },
  { id: 'meta', label: 'Meta Marketing' },
  { id: 'instagram', label: 'Instagram Business' },
  { id: 'twitter', label: 'Twitter/X' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'outlook', label: 'Outlook / Microsoft 365' },
  { id: 'calendly', label: 'Calendly' },
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
  const [availableFeatures, setAvailableFeatures] = useState<AvailableFeature[]>([]);
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
    allowedFeatures: [],
    monthlyTokenAllowance: null,
    monthlyCostAllowance: null,
  });
  const [tokenAllowanceInput, setTokenAllowanceInput] = useState('');
  const [costAllowanceInput, setCostAllowanceInput] = useState('');
  const [usagePolicyEnabled, setUsagePolicyEnabled] = useState(false);
  const [usagePolicyEnforcement, setUsagePolicyEnforcement] = useState<'observe' | 'hard_only' | 'enforce'>('observe');
  const [optimizationThresholdInput, setOptimizationThresholdInput] = useState('');
  const [hardThresholdInput, setHardThresholdInput] = useState('');
  const [optimizedModelsInput, setOptimizedModelsInput] = useState('');
  const [optimizedDefaultInput, setOptimizedDefaultInput] = useState('');
  // Empty string means "not configured", which is NOT the same as the default
  // value. Storing 90 explicitly would freeze today's default onto the tier.
  const [alertPercentInput, setAlertPercentInput] = useState('');
  const [forecastAlertsEnabled, setForecastAlertsEnabled] = useState(true);
  const [topUpEnabled, setTopUpEnabled] = useState(false);
  const [topUpMinimumMarkupInput, setTopUpMinimumMarkupInput] = useState('2.5');
  const [topUpPackagesInput, setTopUpPackagesInput] = useState('');
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadSubscriptionTypes();
    loadAvailableSkills();
    loadAvailablePages();
    loadAvailableFeatures();
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
            allowedFeatures: availableFeatures.map((feature) => feature.id),
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
      if (editingType && !Array.isArray(editingType.allowedFeatures) && availableFeatures.length > 0) {
        setFormData((prev) => ({
          ...prev,
          allowedFeatures: availableFeatures.map((feature) => feature.id),
        }));
      }
    }
  }, [availableSkills, availablePages, availableFeatures, editDialogOpen, editingType]);

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

  const loadAvailableFeatures = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/admin/subscription-features'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (Array.isArray(response.data?.features)) {
        setAvailableFeatures(response.data.features);
      }
    } catch (error) {
      console.error('Error loading subscription features:', error);
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
        allowedFeatures: Array.isArray(type.allowedFeatures)
          ? type.allowedFeatures
          : availableFeatures.map((feature) => feature.id),
        monthlyTokenAllowance: type.monthlyTokenAllowance ?? null,
        monthlyCostAllowance: type.monthlyCostAllowance ?? null,
      };
      setFormData(expandedData);
      setTokenAllowanceInput(type.monthlyTokenAllowance != null ? String(type.monthlyTokenAllowance) : '');
      setCostAllowanceInput(type.monthlyCostAllowance != null ? String(type.monthlyCostAllowance) : '');
      setUsagePolicyEnabled(!!type.llmUsagePolicy);
      setUsagePolicyEnforcement(type.llmUsagePolicy?.enforcementState || 'observe');
      setOptimizationThresholdInput(type.llmUsagePolicy ? String(type.llmUsagePolicy.optimizationCostThresholdMicroUsd / 1_000_000) : '');
      setHardThresholdInput(type.llmUsagePolicy ? String(type.llmUsagePolicy.hardCostThresholdMicroUsd / 1_000_000) : '');
      setOptimizedModelsInput(type.llmUsagePolicy?.optimizedModelIds.join(', ') || '');
      setOptimizedDefaultInput(type.llmUsagePolicy?.optimizedDefaultModel || '');
      setAlertPercentInput(
        type.llmUsagePolicy?.alertUsagePercentThreshold != null
          ? String(type.llmUsagePolicy.alertUsagePercentThreshold)
          : ''
      );
      setForecastAlertsEnabled(type.llmUsagePolicy?.alertOnForecastShortfall !== false);
      setTopUpEnabled(type.llmUsageTopUp?.enabled === true);
      setTopUpMinimumMarkupInput(type.llmUsageTopUp ? String(type.llmUsageTopUp.minimumMarkupBps / 10_000) : '2.5');
      setTopUpPackagesInput(type.llmUsageTopUp?.packages.map((item) => [
        item.id,
        item.label,
        (item.priceCents / 100).toFixed(2),
        (item.usageCreditMicroUsd / 1_000_000).toFixed(2),
        item.active ? 'active' : 'inactive',
      ].join('|')).join('\n') || '');
    } else {
      setEditingType(null);
      // When creating new, start with all pages, skills, and platforms selected
      setFormData({
        name: '',
        allowedPages: availablePages.map((p) => p.path),
        hiddenPages: [],
        allowedSkills: availableSkills.map((s) => s.skillId),
        allowedConnectedAccounts: AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id),
        allowedFeatures: availableFeatures.map((feature) => feature.id),
        monthlyTokenAllowance: null,
        monthlyCostAllowance: null,
      });
      setTokenAllowanceInput('');
      setCostAllowanceInput('');
      setUsagePolicyEnabled(false);
      setUsagePolicyEnforcement('observe');
      setOptimizationThresholdInput('');
      setHardThresholdInput('');
      setOptimizedModelsInput('');
      setOptimizedDefaultInput('');
      setAlertPercentInput('');
      setForecastAlertsEnabled(true);
      setTopUpEnabled(false);
      setTopUpMinimumMarkupInput('2.5');
      setTopUpPackagesInput('');
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
      allowedFeatures: [],
      monthlyTokenAllowance: null,
      monthlyCostAllowance: null,
    });
    setTokenAllowanceInput('');
    setCostAllowanceInput('');
    setUsagePolicyEnabled(false);
    setUsagePolicyEnforcement('observe');
    setOptimizationThresholdInput('');
    setHardThresholdInput('');
    setOptimizedModelsInput('');
    setOptimizedDefaultInput('');
    setAlertPercentInput('');
    setForecastAlertsEnabled(true);
    setTopUpEnabled(false);
    setTopUpMinimumMarkupInput('2.5');
    setTopUpPackagesInput('');
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

      // Parse cost allowance (USD, decimals allowed; empty = unlimited)
      const parsedCostAllowance = costAllowanceInput.trim() === ''
        ? null
        : parseFloat(costAllowanceInput.replace(/[$,]/g, ''));
      if (parsedCostAllowance !== null && (isNaN(parsedCostAllowance) || parsedCostAllowance < 0)) {
        setError('Monthly cost allowance must be a positive dollar amount or empty for unlimited');
        return;
      }

      let llmUsagePolicy: SubscriptionType['llmUsagePolicy'];
      if (usagePolicyEnabled) {
        const optimizationUsd = Number(optimizationThresholdInput.replace(/[$,]/g, ''));
        const hardUsd = Number(hardThresholdInput.replace(/[$,]/g, ''));
        const optimizedModelIds = [...new Set(
          optimizedModelsInput.split(',').map((model) => model.trim()).filter(Boolean)
        )];
        const optimizedDefaultModel = optimizedDefaultInput.trim();
        if (!Number.isFinite(optimizationUsd) || optimizationUsd < 0 || !Number.isFinite(hardUsd) || hardUsd <= optimizationUsd) {
          setError('Hard cost threshold must be greater than the optimization threshold');
          return;
        }
        if (optimizedModelIds.length === 0 || !optimizedDefaultModel || !optimizedModelIds.includes(optimizedDefaultModel)) {
          setError('Choose at least one optimized model and make sure the optimized default is in that list');
          return;
        }
        const alertPercentRaw = alertPercentInput.trim();
        const alertPercent = alertPercentRaw === '' ? null : Number(alertPercentRaw);
        if (alertPercent !== null && (!Number.isInteger(alertPercent) || alertPercent < 1 || alertPercent > 99)) {
          setError('Usage alert threshold must be a whole number between 1 and 99, or blank to use the default');
          return;
        }
        const optimizationCostThresholdMicroUsd = Math.round(optimizationUsd * 1_000_000);
        const hardCostThresholdMicroUsd = Math.round(hardUsd * 1_000_000);
        const previousPolicy = editingType?.llmUsagePolicy;
        const samePolicyDefinition = !!previousPolicy
          && previousPolicy.optimizationCostThresholdMicroUsd === optimizationCostThresholdMicroUsd
          && previousPolicy.hardCostThresholdMicroUsd === hardCostThresholdMicroUsd
          && previousPolicy.optimizedDefaultModel === optimizedDefaultModel
          && JSON.stringify(previousPolicy.optimizedModelIds) === JSON.stringify(optimizedModelIds);
        llmUsagePolicy = {
          // Observe -> hard-only -> full enforcement is one rollout of the same
          // policy. Preserve its version when only the enforcement state changes
          // so the one-time usage reset cannot be applied twice under a new ID.
          version: samePolicyDefinition ? previousPolicy.version : `policy-${Date.now()}`,
          enforcementState: usagePolicyEnforcement,
          optimizationCostThresholdMicroUsd,
          hardCostThresholdMicroUsd,
          optimizedModelIds,
          optimizedDefaultModel,
          // Omitted when blank so the tier keeps following the platform default
          // rather than pinning today's value. The server rejects a present
          // out-of-range value rather than clamping it.
          ...(alertPercent !== null ? { alertUsagePercentThreshold: alertPercent } : {}),
          ...(forecastAlertsEnabled ? {} : { alertOnForecastShortfall: false }),
        };
      }

      let llmUsageTopUp: SubscriptionType['llmUsageTopUp'];
      if (topUpEnabled || topUpPackagesInput.trim()) {
        const minimumMarkup = Number(topUpMinimumMarkupInput);
        const packages = topUpPackagesInput.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const [id, label, priceUsdRaw, creditUsdRaw, status = 'active'] = line.split('|').map((part) => part.trim());
          return {
            id,
            label,
            priceCents: Math.round(Number(priceUsdRaw) * 100),
            usageCreditMicroUsd: Math.round(Number(creditUsdRaw) * 1_000_000),
            active: status.toLowerCase() !== 'inactive',
          };
        });
        if (!Number.isFinite(minimumMarkup) || minimumMarkup < 1) {
          setError('Additional usage minimum markup must be at least 1x');
          return;
        }
        if (packages.some((item) => !item.id || !item.label || !Number.isInteger(item.priceCents) || item.priceCents <= 0 || !Number.isInteger(item.usageCreditMicroUsd) || item.usageCreditMicroUsd <= 0)) {
          setError('Each additional usage package must be id|label|customer price USD|provider usage USD|active');
          return;
        }
        llmUsageTopUp = {
          enabled: topUpEnabled,
          minimumMarkupBps: Math.round(minimumMarkup * 10_000),
          packages,
        };
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
        allowedFeatures: formData.allowedFeatures || [],
        monthlyTokenAllowance: parsedAllowance,
        monthlyCostAllowance: parsedCostAllowance,
        ...(llmUsagePolicy ? { llmUsagePolicy } : {}),
        ...(llmUsageTopUp ? { llmUsageTopUp } : {}),
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

  const handleToggleFeature = (featureId: string) => {
    const current = formData.allowedFeatures || [];
    setFormData({
      ...formData,
      allowedFeatures: current.includes(featureId)
        ? current.filter((id) => id !== featureId)
        : [...current, featureId],
    });
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
                <TableCell>Monthly Cost Allowance</TableCell>
                <TableCell>LLM Usage Policy</TableCell>
                <TableCell>Allowed Pages</TableCell>
                <TableCell>Allowed Skills</TableCell>
                <TableCell>Connected Accounts</TableCell>
                <TableCell>Product Features</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {subscriptionTypes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} align="center">
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
                      <Typography variant="body2">
                        {type.monthlyCostAllowance != null
                          ? `$${type.monthlyCostAllowance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : 'Unlimited'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {type.llmUsagePolicy ? (
                        <Chip
                          label={`${type.llmUsagePolicy.enforcementState === 'enforce' ? 'Hard + optimized' : type.llmUsagePolicy.enforcementState === 'hard_only' ? 'Hard cap only' : 'Observe'} · $${type.llmUsagePolicy.optimizationCostThresholdMicroUsd / 1_000_000} → $${type.llmUsagePolicy.hardCostThresholdMicroUsd / 1_000_000}`}
                          color={type.llmUsagePolicy.enforcementState === 'enforce' ? 'warning' : type.llmUsagePolicy.enforcementState === 'hard_only' ? 'error' : 'default'}
                          size="small"
                        />
                      ) : (
                        <Typography variant="body2" color="text.secondary">Legacy</Typography>
                      )}
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
                      {(type.allowedFeatures || []).length === 0 ? (
                        <Typography variant="body2" color="text.secondary">None</Typography>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          {(type.allowedFeatures || []).length} enabled
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

            <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
              <FormControlLabel
                control={<Checkbox checked={usagePolicyEnabled} onChange={(e) => setUsagePolicyEnabled(e.target.checked)} />}
                label="Enable versioned LLM usage policy"
              />
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Cost—not raw tokens—controls full model choice, optimized model usage, and the hard pause.
              </Typography>
              <Collapse in={usagePolicyEnabled}>
                <TextField
                  select
                  fullWidth
                  label="Rollout state"
                  value={usagePolicyEnforcement}
                  onChange={(e) => setUsagePolicyEnforcement(e.target.value as 'observe' | 'hard_only' | 'enforce')}
                  sx={{ mb: 2 }}
                >
                  <MenuItem value="observe">Observe only</MenuItem>
                  <MenuItem value="hard_only">Enforce hard cap only</MenuItem>
                  <MenuItem value="enforce">Enforce hard cap + optimized models</MenuItem>
                </TextField>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 2 }}>
                  <TextField
                    label="Optimization threshold (USD)"
                    value={optimizationThresholdInput}
                    onChange={(e) => setOptimizationThresholdInput(e.target.value)}
                    inputProps={{ inputMode: 'decimal' }}
                  />
                  <TextField
                    label="Hard threshold (USD)"
                    value={hardThresholdInput}
                    onChange={(e) => setHardThresholdInput(e.target.value)}
                    inputProps={{ inputMode: 'decimal' }}
                  />
                </Box>
                <TextField
                  fullWidth
                  label="Optimized model IDs"
                  value={optimizedModelsInput}
                  onChange={(e) => setOptimizedModelsInput(e.target.value)}
                  placeholder="gemini-3.1-flash-lite, anthropic.claude-haiku-4-5-20251001-v1:0"
                  helperText="Comma-separated stable model IDs. Unknown or unpriced models are rejected by the server."
                  sx={{ mb: 2 }}
                />
                <TextField
                  fullWidth
                  label="Optimized default model"
                  value={optimizedDefaultInput}
                  onChange={(e) => setOptimizedDefaultInput(e.target.value)}
                  helperText="Used when the preferred model and user backup are unavailable or restricted."
                  sx={{ mb: 2 }}
                />
                <TextField
                  fullWidth
                  label="Usage alert threshold (%)"
                  value={alertPercentInput}
                  onChange={(e) => setAlertPercentInput(e.target.value)}
                  placeholder="90"
                  helperText="Percent of the allowance at which customers are warned. Leave blank to follow the platform default (90%)."
                  sx={{ mb: 1 }}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={forecastAlertsEnabled}
                      onChange={(e) => setForecastAlertsEnabled(e.target.checked)}
                    />
                  }
                  label="Warn when usage is forecast to run out before reset"
                />
              </Collapse>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
              <FormControlLabel
                control={<Checkbox checked={topUpEnabled} onChange={(e) => setTopUpEnabled(e.target.checked)} />}
                label="Allow additional AgentWeb usage purchases"
              />
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Customer prices and underlying provider-usage credits are admin-controlled. Customers see only the package label and price.
              </Typography>
              <TextField
                fullWidth
                label="Minimum markup multiplier"
                value={topUpMinimumMarkupInput}
                onChange={(e) => setTopUpMinimumMarkupInput(e.target.value)}
                inputProps={{ inputMode: 'decimal' }}
                helperText="For example, 2.5 requires a $25 charge for $10 of provider usage."
                sx={{ mb: 2 }}
              />
              <TextField
                fullWidth
                multiline
                minRows={3}
                label="Additional usage packages"
                value={topUpPackagesInput}
                onChange={(e) => setTopUpPackagesInput(e.target.value)}
                placeholder="aw-10|10 AgentWeb Credits|25.00|10.00|active"
                helperText="One per line: id | customer label | customer price USD | provider usage USD | active/inactive"
              />
            </Paper>

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

            <TextField
              label="Monthly Cost Allowance (USD)"
              fullWidth
              value={costAllowanceInput}
              onChange={(e) => setCostAllowanceInput(e.target.value)}
              sx={{ mb: 3 }}
              placeholder="Leave empty for unlimited"
              helperText="Legacy per-user monthly LLM spend cap. New tiers should use the versioned LLM usage policy above."
              type="text"
              inputProps={{ inputMode: 'decimal', pattern: '[0-9.,$]*' }}
            />

            <Typography variant="h6" gutterBottom>
              Product Features
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              These entitlements are enforced by the API, background jobs, and customer portal.
            </Typography>
            <FormGroup sx={{ mb: 3 }}>
              {availableFeatures.map((feature) => (
                <FormControlLabel
                  key={feature.id}
                  control={(
                    <Checkbox
                      checked={(formData.allowedFeatures || []).includes(feature.id)}
                      onChange={() => handleToggleFeature(feature.id)}
                    />
                  )}
                  label={(
                    <Box>
                      <Typography variant="body2">{feature.label}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {feature.description}
                      </Typography>
                    </Box>
                  )}
                />
              ))}
            </FormGroup>

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
