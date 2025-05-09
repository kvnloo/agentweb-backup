import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { buildApiUrl } from '@/config';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Separator } from "@/components/ui/separator";

// Define interfaces based on expected structure of changelog data
// Assuming a structure like:
// {
//   version: "1.2.3",
//   date: "2024-07-30",
//   title: "New Features and Fixes",
//   notes: [
//     "Added feature X.",
//     "Fixed bug Y.",
//     "Improved performance of Z."
//   ]
// }
// Or a list of such entries if the API returns an array directly.
// For now, let's assume the API returns an array of ChangelogEntry.
// If it's a single object with a 'releases' array, we'll adjust.

interface ChangelogEntry {
  date: string;
  changes: string[]; // Renamed from notes, and it's not optional based on the response
  // version and title are removed as they are not in the API response
}

const ChangelogPage: React.FC = () => {
  // Assuming the API will return an array of changelog entries
  // or an object with a property (e.g., 'releases') containing the array.
  // For now, let's expect an array directly.
  const [changelogEntries, setChangelogEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { token } = useAuth();

  useEffect(() => {
    const fetchChangelog = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await axios.get(buildApiUrl('/api/docs/user-release'), {
          headers: token ? { Authorization: `Bearer ${token}` } : {}, // Add auth header if token exists
        });
        
        // Assuming response.data.data is an array of ChangelogEntry
        // Or response.data directly if the API returns the array at the root
        if (response.data && Array.isArray(response.data.data)) {
          setChangelogEntries(response.data.data);
        } else if (response.data && Array.isArray(response.data)) { // Fallback if data is directly the array
           setChangelogEntries(response.data);
        } else if (response.data && response.data.success && Array.isArray(response.data.data)) { // Common pattern
          setChangelogEntries(response.data.data);
        }
        // If the structure is different, e.g., an object with a 'releases' field:
        // else if (response.data && response.data.releases && Array.isArray(response.data.releases)) {
        //   setChangelogEntries(response.data.releases);
        // } 
        else {
          // Log the actual response structure if it's not as expected
          console.warn('Unexpected changelog data structure:', response.data);
          setError('Failed to load changelog: Unexpected data format.');
        }
      } catch (err: any) {
        console.error("Failed to fetch changelog:", err);
        setError(err.response?.data?.message || 'An error occurred while fetching the changelog.');
      } finally {
        setLoading(false);
      }
    };

    fetchChangelog();
  }, [token]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="ml-2">Loading changelog...</p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="my-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error Loading Changelog</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!changelogEntries || changelogEntries.length === 0) {
    return (
      <div className="container mx-auto py-8 px-4 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
            Changelog
          </h1>
          <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
            No recent updates found.
          </p>
        </header>
      </div>
    );
  }
  
  return (
    <div className="container mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
          Changelog & Release Notes
        </h1>
        <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
          Stay updated with the latest changes, improvements, and features.
        </p>
      </header>

      <div className="space-y-10">
        {changelogEntries.map((entry, entryIndex) => (
          <Card key={entryIndex} className="overflow-hidden">
            <CardHeader className="bg-gray-50 dark:bg-gray-800 py-4 px-6">
              <div className="flex justify-between items-center mb-1">
                <CardTitle className="text-xl font-semibold text-gray-800 dark:text-gray-100">
                  Release Update
                </CardTitle>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {new Date(entry.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
              </div>
              <Separator className="my-2" />
            </CardHeader>
            <CardContent className="p-6 pt-4 space-y-1.5">
              {entry.changes && Array.isArray(entry.changes) && entry.changes.map((changeText, index) => {
                const isSubItem = changeText.startsWith('- ');
                // Extract the actual text, removing the "- " prefix from sub-items.
                const textContent = isSubItem ? changeText.substring(2) : changeText;

                return (
                  <div key={index} className={`flex items-start text-gray-700 dark:text-gray-300 ${isSubItem ? 'ml-5' : 'ml-0'}`}>
                    <span className="mr-2 flex-shrink-0">•</span>
                    <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {textContent}
                      </ReactMarkdown>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default ChangelogPage; 