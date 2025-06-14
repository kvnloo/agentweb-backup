import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { buildApiUrl } from "@/config";
import axios from "axios";
import { Loader2 } from "lucide-react";

interface LeadListSectionProps {
  taskId: string;
  updateLeadList: boolean;
}

interface LeadRecord {
  taskId: string;
  identifier: string;
  data: Record<string, any>;
}

export const LeadListSection: React.FC<LeadListSectionProps> = ({
  taskId,
  updateLeadList
}) => {
  const { token } = useAuth();
  const [records, setRecords] = useState<LeadRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchLeadList = async () => {
      if (!updateLeadList) return;
      
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
      } catch (err) {
        console.error('Error fetching lead list:', err);
        setError('Failed to load lead list');
      } finally {
        setLoading(false);
      }
    };

    fetchLeadList();
  }, [taskId, updateLeadList, token]);

  if (!updateLeadList) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead List</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-red-500">{error}</div>
        ) : records.length === 0 ? (
          <div className="text-muted-foreground">No records found</div>
        ) : (
          <div className="space-y-4">
            {records.map((record, index) => (
              <div key={index} className="border rounded-lg p-4">
                <pre className="whitespace-pre-wrap break-words">
                  {JSON.stringify(record.data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}; 