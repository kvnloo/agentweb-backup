import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, Box, IconButton, Button, TextField, Typography, CircularProgress, Alert } from "@mui/material";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";
import axios from "axios";
import { Edit as EditIcon, Save as SaveIcon, Cancel as CancelIcon } from '@mui/icons-material';

interface LeadListSectionProps {
  taskId: string;
  updateLeadList: boolean;
  leadListIdentifier: string;
}

interface LeadRecord {
  identifier: string;
  data: { [key: string]: unknown };
  updatedAt: string;
}

export const LeadListSection: React.FC<LeadListSectionProps> = ({
  taskId,
  updateLeadList,
  leadListIdentifier
}) => {
  const { token } = useAuth();
  const [records, setRecords] = useState<LeadRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');

  useEffect(() => {
    fetchLeadList();
  }, [taskId]);

  const fetchLeadList = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/lead-list`),
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      setRecords(response.data.records || []);
      // Just use the data array directly
      setEditedContent(JSON.stringify(response.data.records.map((r: LeadRecord) => r.data), null, 2));
    } catch (err) {
      console.error('Error fetching lead list:', err);
      setError('Failed to load lead list');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = () => {
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditedContent(JSON.stringify(records.map(r => r.data), null, 2));
  };

  const handleSave = async () => {
    try {
      let parsedData: { [key: string]: unknown }[];
      try {
        parsedData = JSON.parse(editedContent);
        if (!Array.isArray(parsedData)) {
          throw new Error('Content must be an array of records');
        }
        // Validate each record has the required identifier field
        for (const data of parsedData) {
          if (!data[leadListIdentifier]) {
            throw new Error(`Each record must have a ${leadListIdentifier} field`);
          }
        }
      } catch (err) {
        setError('Invalid JSON format. Please check your input.');
        return;
      }

      // Send only the data array to the backend
      const response = await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/lead-list`), 
        { records: parsedData },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setRecords(response.data.records);
      setIsEditing(false);
      setError(null);
    } catch (err) {
      setError('Failed to save changes');
      console.error('Error saving lead list:', err);
    }
  };

  const handleContentChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEditedContent(event.target.value);
    setError(null);
  };

  // If updateLeadList is off and there are no records, don't show the section
  // If updateLeadList is on, show the section even if empty
  if (!updateLeadList && records.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader 
        title="Lead List"
        action={
          !isEditing ? (
            <IconButton onClick={handleEdit} color="primary">
              <EditIcon />
            </IconButton>
          ) : (
            <Box>
              <IconButton onClick={handleSave} color="primary">
                <SaveIcon />
              </IconButton>
              <IconButton onClick={handleCancel} color="error">
                <CancelIcon />
              </IconButton>
            </Box>
          )
        }
      />
      <CardContent sx={{ 
        height: 400,
        overflowY: 'auto',
        '&::-webkit-scrollbar': {
          width: '8px',
        },
        '&::-webkit-scrollbar-track': {
          background: '#f1f1f1',
          borderRadius: '4px',
        },
        '&::-webkit-scrollbar-thumb': {
          background: '#888',
          borderRadius: '4px',
          '&:hover': {
            background: '#555',
          },
        },
      }}>
        {loading ? (
          <Box display="flex" justifyContent="center" alignItems="center" height="100%">
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : isEditing ? (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
              Edit the records below. Each record must have a {leadListIdentifier} field.
            </Typography>
            <TextField
              fullWidth
              multiline
              rows={20}
              value={editedContent}
              onChange={handleContentChange}
              error={!!error}
              helperText={error}
              sx={{ 
                fontFamily: 'monospace',
                '& .MuiInputBase-root': {
                  height: '100%',
                },
              }}
            />
          </Box>
        ) : records.length === 0 ? (
          <Typography color="text.secondary" sx={{ textAlign: 'center', mt: 2 }}>
            No records found. Click the edit button to add records.
          </Typography>
        ) : (
          <Box sx={{ fontFamily: 'monospace' }}>
            {records.map((record) => (
              <Box key={record.identifier} sx={{ mb: 2 }}>
                <Box sx={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  mb: 1,
                  color: 'text.secondary',
                  fontSize: '0.875rem'
                }}>
                  <Typography variant="subtitle2" color="primary">
                    {record.identifier}
                  </Typography>
                  <Typography variant="caption">
                    Last updated: {new Date(record.updatedAt).toLocaleString()}
                  </Typography>
                </Box>
                <pre style={{ 
                  margin: 0, 
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: '8px',
                  backgroundColor: '#f5f5f5',
                  borderRadius: '4px',
                }}>
                  {JSON.stringify(record.data, null, 2)}
                </pre>
              </Box>
            ))}
          </Box>
        )}
      </CardContent>
    </Card>
  );
};

// Helper function to validate JSON
function isValidJSON(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch (e) {
    return false;
  }
} 