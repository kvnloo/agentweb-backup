import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Box, Paper, Typography } from '@mui/material';
import { Loop as LoopIcon } from '@mui/icons-material';

interface LoopData {
  label: string;
  loopCount?: number;
}

const LoopNode = ({ data }: NodeProps<LoopData>) => {
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
        <LoopIcon color="primary" />
        <Typography variant="subtitle1">{data.label}</Typography>
      </Box>
      {data.loopCount && (
        <Typography variant="caption" color="text.secondary">
          Iterations: {data.loopCount}
        </Typography>
      )}
      <Handle type="source" position={Position.Bottom} />
    </Paper>
  );
};

export default memo(LoopNode); 