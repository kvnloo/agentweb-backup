import { ReactNode } from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import { Refresh as RefreshIcon } from '@mui/icons-material';

interface ActionProps {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
}

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ActionProps;
}

/**
 * Shared empty state (ENG-2526). Always names the next action the user can take,
 * so a list never renders as a bare "nothing here".
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <Paper
      data-testid="empty-state"
      sx={{
        textAlign: 'center',
        py: { xs: 4, sm: 6 },
        px: { xs: 2, sm: 3 },
        borderRadius: '16px',
        border: '1px dashed',
        borderColor: 'grey.300',
      }}
    >
      <Typography variant="h6" color="text.secondary" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: action ? 3 : 0 }}>
        {description}
      </Typography>
      {action && (
        <Button variant="contained" onClick={action.onClick} startIcon={action.icon}>
          {action.label}
        </Button>
      )}
    </Paper>
  );
}

interface ErrorStateProps {
  title: string;
  description?: string;
  onRetry: () => void;
  retrying?: boolean;
}

/**
 * Shared retryable error state (ENG-2526). Replaces raw error strings and
 * spinner-forever on failed fetches with a plain explanation plus a Retry action.
 */
export function ErrorState({ title, description, onRetry, retrying = false }: ErrorStateProps) {
  return (
    <Paper
      role="alert"
      data-testid="error-state"
      sx={{
        textAlign: 'center',
        py: { xs: 4, sm: 6 },
        px: { xs: 2, sm: 3 },
        borderRadius: '16px',
        border: '1px solid',
        borderColor: 'error.light',
      }}
    >
      <Typography variant="h6" color="error" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      <Box sx={{ mb: 3 }}>
        <Typography variant="body2" color="text.secondary">
          {description ?? 'Check your connection, then try again. If this keeps happening, contact support.'}
        </Typography>
      </Box>
      <Button variant="outlined" onClick={onRetry} disabled={retrying} startIcon={<RefreshIcon />}>
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </Paper>
  );
}
