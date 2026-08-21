import { useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArrowDownward as ArrowDownwardIcon,
  ArrowUpward as ArrowUpwardIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import {
  type EditableWorkPlanInputField,
  type EditableWorkPlanInputRequest,
  validateEditableInputRequest,
} from './workPlanInputSchema';

function nextFieldId(fields: EditableWorkPlanInputField[]): string {
  const used = new Set(fields.map((field) => field.id));
  let sequence = fields.length + 1;
  while (used.has(`field_${sequence}`)) sequence += 1;
  return `field_${sequence}`;
}

function nextOptionValue(options: Array<{ value: string; label: string }>): string {
  const used = new Set(options.map((option) => option.value));
  let sequence = options.length + 1;
  while (used.has(`option_${sequence}`)) sequence += 1;
  return `option_${sequence}`;
}

function changeFieldType(
  field: EditableWorkPlanInputField,
  type: EditableWorkPlanInputField['type'],
): EditableWorkPlanInputField {
  const base = {
    id: field.id,
    label: field.label,
    type,
    required: field.required,
    helpText: field.helpText,
  };
  if (type === 'select') {
    return {
      ...base,
      options: field.options?.length
        ? field.options
        : [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }],
    };
  }
  return base;
}

function previewInput(field: EditableWorkPlanInputField) {
  const common = {
    disabled: true,
    'aria-label': `${field.label} preview`,
    style: {
      width: '100%',
      minHeight: 38,
      borderRadius: 8,
      border: '1px solid rgba(148, 163, 184, .35)',
      background: '#11151d',
      color: '#f5f7fb',
      padding: '8px 10px',
    },
  };
  if (field.type === 'select') {
    return (
      <select {...common} defaultValue={typeof field.defaultValue === 'string' ? field.defaultValue : ''}>
        <option value="">Choose…</option>
        {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return <select {...common} defaultValue={field.defaultValue === true ? 'Yes' : field.defaultValue === false ? 'No' : ''}><option value="">Choose…</option><option>Yes</option><option>No</option></select>;
  }
  return <input {...common} type={field.type === 'number' ? 'number' : 'text'} defaultValue={field.defaultValue as string | number | undefined} />;
}

export default function WorkPlanInputEditor({
  value,
  onChange,
}: {
  value: EditableWorkPlanInputRequest;
  onChange: (value: EditableWorkPlanInputRequest) => void;
}) {
  const errors = useMemo(() => validateEditableInputRequest(value), [value]);
  const updateField = (index: number, patch: Partial<EditableWorkPlanInputField>) => {
    onChange({
      ...value,
      fields: value.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field),
    });
  };
  const moveField = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= value.fields.length) return;
    const fields = [...value.fields];
    [fields[index], fields[destination]] = [fields[destination], fields[index]];
    onChange({ ...value, fields });
  };

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.15fr) minmax(320px, .85fr)' }, gap: 2 }}>
      <Stack spacing={1.5}>
        {errors.length > 0 && <Alert severity="warning">{errors[0]}</Alert>}
        <TextField
          label="Card title"
          value={value.title}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          size="small"
          fullWidth
        />
        <TextField
          label="Short question"
          value={value.prompt}
          onChange={(event) => onChange({ ...value, prompt: event.target.value })}
          helperText="Keep this to one sentence. The fields below carry the details."
          size="small"
          fullWidth
        />

        {value.fields.map((field, index) => (
          <Paper key={field.id} variant="outlined" sx={{ p: 1.5 }}>
            <Stack spacing={1.25}>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 170px auto', gap: 1, alignItems: 'start' }}>
                <TextField
                  label="Answer label"
                  value={field.label}
                  onChange={(event) => updateField(index, { label: event.target.value })}
                  size="small"
                  fullWidth
                />
                <FormControl size="small" fullWidth>
                  <InputLabel id={`answer-type-${field.id}`}>Answer type</InputLabel>
                  <Select
                    labelId={`answer-type-${field.id}`}
                    inputProps={{ 'aria-label': 'Answer type' }}
                    label="Answer type"
                    value={field.type}
                    onChange={(event) => {
                      const fields = value.fields.map((candidate, fieldIndex) => (
                        fieldIndex === index
                          ? changeFieldType(candidate, event.target.value as EditableWorkPlanInputField['type'])
                          : candidate
                      ));
                      onChange({ ...value, fields });
                    }}
                  >
                    <MenuItem value="text">Short text</MenuItem>
                    <MenuItem value="url">Website</MenuItem>
                    <MenuItem value="number">Number</MenuItem>
                    <MenuItem value="boolean">Yes or no</MenuItem>
                    <MenuItem value="select">Choose from a list</MenuItem>
                  </Select>
                </FormControl>
                <Box sx={{ display: 'flex' }}>
                  <IconButton aria-label="Move answer up" disabled={index === 0} onClick={() => moveField(index, -1)}><ArrowUpwardIcon fontSize="small" /></IconButton>
                  <IconButton aria-label="Move answer down" disabled={index === value.fields.length - 1} onClick={() => moveField(index, 1)}><ArrowDownwardIcon fontSize="small" /></IconButton>
                  <IconButton aria-label="Remove answer" disabled={value.fields.length === 1} onClick={() => onChange({ ...value, fields: value.fields.filter((_, fieldIndex) => fieldIndex !== index) })}><CloseIcon fontSize="small" /></IconButton>
                </Box>
              </Box>
              <TextField
                label="Helpful hint (optional)"
                value={field.helpText || ''}
                onChange={(event) => updateField(index, { helpText: event.target.value || undefined })}
                size="small"
                fullWidth
              />
              <FormControlLabel
                control={<Checkbox checked={field.required === true} onChange={(event) => updateField(index, { required: event.target.checked })} />}
                label="Required"
              />

              {field.type === 'select' && (
                <Box>
                  <Typography variant="caption" fontWeight={600}>Choices</Typography>
                  <Stack spacing={1} sx={{ mt: 0.5 }}>
                    {field.options?.map((option, optionIndex) => (
                      <Box key={option.value} sx={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 1 }}>
                        <TextField
                          aria-label={`Choice ${optionIndex + 1}`}
                          value={option.label}
                          onChange={(event) => updateField(index, {
                            options: field.options?.map((candidate, candidateIndex) => candidateIndex === optionIndex ? { ...candidate, label: event.target.value } : candidate),
                          })}
                          size="small"
                        />
                        <IconButton aria-label="Remove choice" disabled={(field.options?.length || 0) <= 2} onClick={() => updateField(index, { options: field.options?.filter((_, candidateIndex) => candidateIndex !== optionIndex) })}><CloseIcon fontSize="small" /></IconButton>
                      </Box>
                    ))}
                    <Button size="small" startIcon={<AddIcon />} onClick={() => {
                      const optionNumber = (field.options?.length || 0) + 1;
                      const existingOptions = field.options || [];
                      updateField(index, { options: [...existingOptions, { value: nextOptionValue(existingOptions), label: `Option ${optionNumber}` }] });
                    }}>Add choice</Button>
                  </Stack>
                </Box>
              )}

              {field.type === 'number' && (
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                  <TextField label="Minimum (optional)" type="number" value={field.minimum ?? ''} onChange={(event) => updateField(index, { minimum: event.target.value === '' ? undefined : Number(event.target.value) })} size="small" />
                  <TextField label="Maximum (optional)" type="number" value={field.maximum ?? ''} onChange={(event) => updateField(index, { maximum: event.target.value === '' ? undefined : Number(event.target.value) })} size="small" />
                </Box>
              )}

              <Box component="details">
                <Typography component="summary" variant="caption" sx={{ cursor: 'pointer', color: 'text.secondary' }}>Advanced</Typography>
                <TextField
                  label="Internal key"
                  value={field.id}
                  onChange={(event) => updateField(index, { id: event.target.value })}
                  helperText="Stable key used by Emma and MCP. Usually leave this alone."
                  size="small"
                  fullWidth
                  sx={{ mt: 1 }}
                />
                {(field.type === 'text' || field.type === 'url') && (
                  <TextField
                    label="Default answer (optional)"
                    value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
                    onChange={(event) => updateField(index, { defaultValue: event.target.value || undefined })}
                    size="small"
                    fullWidth
                    sx={{ mt: 1 }}
                  />
                )}
                {field.type === 'number' && (
                  <TextField
                    label="Default answer (optional)"
                    type="number"
                    value={typeof field.defaultValue === 'number' ? field.defaultValue : ''}
                    onChange={(event) => updateField(index, { defaultValue: event.target.value === '' ? undefined : Number(event.target.value) })}
                    size="small"
                    fullWidth
                    sx={{ mt: 1 }}
                  />
                )}
                {field.type === 'boolean' && (
                  <FormControl size="small" fullWidth sx={{ mt: 1 }}>
                    <InputLabel>Default answer</InputLabel>
                    <Select
                      label="Default answer"
                      value={typeof field.defaultValue === 'boolean' ? String(field.defaultValue) : ''}
                      onChange={(event) => updateField(index, {
                        defaultValue: event.target.value === '' ? undefined : event.target.value === 'true',
                      })}
                    >
                      <MenuItem value=""><em>No default</em></MenuItem>
                      <MenuItem value="true">Yes</MenuItem>
                      <MenuItem value="false">No</MenuItem>
                    </Select>
                  </FormControl>
                )}
                {field.type === 'select' && (
                  <FormControl size="small" fullWidth sx={{ mt: 1 }}>
                    <InputLabel>Default answer</InputLabel>
                    <Select
                      label="Default answer"
                      value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
                      onChange={(event) => updateField(index, { defaultValue: event.target.value || undefined })}
                    >
                      <MenuItem value=""><em>No default</em></MenuItem>
                      {field.options?.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                )}
              </Box>
            </Stack>
          </Paper>
        ))}
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          disabled={value.fields.length >= 8}
          onClick={() => onChange({
            ...value,
            fields: [...value.fields, { id: nextFieldId(value.fields), label: 'New answer', type: 'text', required: true }],
          })}
        >
          Add another answer
        </Button>
      </Stack>

      <Box sx={{ position: { lg: 'sticky' }, top: 12, alignSelf: 'start' }}>
        <Typography variant="overline" color="text.secondary">Customer preview</Typography>
        <Paper
          data-testid="workplan-input-preview"
          variant="outlined"
          sx={{ p: 2.5, bgcolor: '#292934', color: '#f5f5f7', borderColor: '#3a3a49', borderRadius: 2 }}
        >
          <Typography variant="caption" sx={{ color: '#f5ad52', fontWeight: 700, letterSpacing: '.04em' }}>DETAILS NEEDED TO CONTINUE</Typography>
          <Typography variant="h6" sx={{ mt: 0.75 }}>{value.title || 'Card title'}</Typography>
          <Typography variant="body2" sx={{ mt: 0.5, mb: 2, color: '#c8c8d0' }}>{value.prompt || 'Short question'}</Typography>
          <Stack spacing={1.5}>
            {value.fields.map((field) => (
              <Box key={field.id}>
                <Typography component="label" variant="body2" sx={{ display: 'block', fontWeight: 600, mb: 0.5 }}>
                  {field.label || 'Answer label'}{field.required ? ' *' : ''}
                </Typography>
                {previewInput(field)}
                {field.helpText && <Typography variant="caption" sx={{ color: '#9fa0aa' }}>{field.helpText}</Typography>}
              </Box>
            ))}
            <Button disabled variant="contained" sx={{ alignSelf: 'start', bgcolor: '#f5ad52 !important', color: '#17171d !important' }}>Continue</Button>
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}
