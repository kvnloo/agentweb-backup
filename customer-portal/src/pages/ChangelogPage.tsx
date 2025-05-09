import { useEffect, useState } from 'react';
import axios from 'axios';
import { useAuth } from '@/contexts/AuthContext';
import { buildApiUrl } from '@/config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";
import Layout from '@/components/layout/Layout'; // Changed to default import

interface UserReleaseNote {
  date: string;
  changes: string[];
}

const ChangelogPage = () => {
  const { token } = useAuth(); // Get token for API calls
  const [releaseNotes, setReleaseNotes] = useState<UserReleaseNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchReleaseNotes = async () => {
      if (!token) {
        // setError('Authentication token is missing.'); // Or allow public access
        // setIsLoading(false);
        // return;
      } // Allowing no-token for now, assuming public endpoint

      setIsLoading(true);
      setError(null);
      try {
        const response = await axios.get<UserReleaseNote[]>(buildApiUrl('/api/docs/user-release'), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        // Assuming release notes are sorted newest first from backend, if not, sort here:
        // response.data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setReleaseNotes(response.data);
      } catch (err: any) {
        console.error('Error fetching release notes:', err);
        setError(err.response?.data?.message || 'Failed to load changelog.');
      } finally {
        setIsLoading(false); // Use finally to ensure isLoading is always set to false
      }
    };

    fetchReleaseNotes();
  }, [token]); // Re-fetch if token changes, though endpoint might be public

  const formatDateForDisplay = (dateStr: string) => {
    try {
      const date = new Date(dateStr + 'T00:00:00'); // Ensure date is parsed as local if only YYYY-MM-DD
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return dateStr; // Fallback to raw date string
    }
  };

  return (
    <Layout>
      <div className="py-8 px-4 md:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl mb-8">
          Changelog
        </h1>

        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="ml-4 text-lg">Loading updates...</p>
          </div>
        )}

        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>Error Loading Changelog</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!isLoading && !error && releaseNotes.length === 0 && (
          <p className="text-center text-muted-foreground py-10">No release notes available at the moment.</p>
        )}

        {!isLoading && !error && releaseNotes.length > 0 && (
          <div className="space-y-8">
            {releaseNotes.map((note, index) => (
              <Card key={index}>
                <CardHeader>
                  <CardTitle>{formatDateForDisplay(note.date)}</CardTitle>
                  {/* Optionally, if you add a version or status to UserReleaseNote in backend later */}
                  {/* <CardDescription>Version 1.2.3 - In Progress</CardDescription> */}
                </CardHeader>
                <CardContent>
                  <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
                    {note.changes.map((change, changeIndex) => (
                      <li key={changeIndex}>{change}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
};

export default ChangelogPage; 