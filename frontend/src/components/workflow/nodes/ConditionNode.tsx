import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Box, Paper, Typography } from '@mui/material';
import { CallSplit as ConditionIcon } from '@mui/icons-material';

interface ConditionData {
  label: string;
  condition?: string;
}

const ConditionNode = ({ data }: NodeProps<ConditionData>) => {
  return (
    <Paper
      elevation={2}
      sx={{
        padding: 2,
        minWidth: 180,
        backgroundColor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider'
      }}
    >
      <Handle type="target" position={Position.Top} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ConditionIcon color="primary" />
        <Typography variant="subtitle1">{data.label}</Typography>
      </Box>
      {data.condition && (
        <Typography variant="caption" color="text.secondary">
          Condition: {data.condition}
        </Typography>
      )}
      <Handle type="source" position={Position.Bottom} id="true" />
      <Handle
        type="source"
        position={Position.Right}
        id="false"
        style={{ top: '50%' }}
      />
    </Paper>
  );
};

export default memo(ConditionNode); 