import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Box, Paper, Typography } from '@mui/material';
import { Task as TaskIcon } from '@mui/icons-material';

interface TaskData {
  label: string;
  taskId?: string;
}

const TaskNode = ({ data }: NodeProps<TaskData>) => {
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
        <TaskIcon color="primary" />
        <Typography variant="subtitle1">{data.label}</Typography>
      </Box>
      {data.taskId && (
        <Typography variant="caption" color="text.secondary">
          Task ID: {data.taskId}
        </Typography>
      )}
      <Handle type="source" position={Position.Bottom} />
    </Paper>
  );
};

export default memo(TaskNode); 