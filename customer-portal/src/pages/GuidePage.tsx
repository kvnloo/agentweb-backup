import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { buildApiUrl } from '@/config'; // Assuming you have this for API URL construction
import { useAuth } from '@/contexts/AuthContext'; // To get the token for authenticated requests
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ReactMarkdown from 'react-markdown'; // Import ReactMarkdown
import remarkGfm from 'remark-gfm'; // Import remarkGfm for tables, strikethrough, task lists, URLs

interface UserGuideSubsection {
  title: string;
  content: string[];
}

interface UserGuideSection {
  title: string;
  content: string[];
  subsections?: UserGuideSubsection[];
}

const GuidePage: React.FC = () => {
  const [guideSections, setGuideSections] = useState<UserGuideSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { token } = useAuth(); // Get token if API requires authentication

  useEffect(() => {
    const fetchGuide = async () => {
      if (!token) { // Optional: if your API doesn't require a token, remove this check
        // setError("Authentication token not available."); // Or allow unauthenticated access
        // setLoading(false);
        // return;
      }
      setLoading(true);
      setError(null);
      try {
        // The user guide endpoint seems to be /api/docs/user-guide based on user request
        // but the controller was named user-guide.ts which typically serves /api/user-guide
        // Let's try /api/user-guide first, as /api/docs/* is usually for more technical/API docs.
        // If this fails, we can try /api/docs/user-guide
        // Correcting the endpoint based on user feedback:
        const response = await axios.get(buildApiUrl('/api/docs/user-guide'), {
          headers: { Authorization: `Bearer ${token}` }, // Add auth header
        });
        if (response.data && response.data.success) {
          setGuideSections(response.data.data);
        } else {
          setError(response.data.message || 'Failed to load user guide data.');
        }
      } catch (err: any) {
        console.error("Failed to fetch user guide:", err);
        setError(err.response?.data?.message || 'An error occurred while fetching the user guide.');
      } finally {
        setLoading(false);
      }
    };

    fetchGuide();
  }, [token]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="ml-2">Loading guide...</p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="my-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error Loading Guide</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
          Customer Portal User Guide
        </h1>
        <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">
          Everything you need to know to make the most out of your portal.
        </p>
      </header>

      <div className="space-y-10">
        {guideSections.map((section, sectionIndex) => (
          <Card key={sectionIndex} className="overflow-hidden">
            <CardHeader className="bg-gray-50 dark:bg-gray-800">
              <CardTitle className="text-xl font-semibold text-gray-800 dark:text-gray-100">
                {section.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              {section.content.map((paragraph, pIndex) => (
                <div key={pIndex} className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300 leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{paragraph}</ReactMarkdown>
                </div>
              ))}
              {section.subsections && section.subsections.length > 0 && (
                <div className="mt-6 space-y-6 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
                  {section.subsections.map((subsection, subIndex) => (
                    <div key={subIndex}>
                      <h3 className="text-lg font-medium text-gray-800 dark:text-gray-200 mb-2">
                        {subsection.title}
                      </h3>
                      {subsection.content.map((subParagraph, spIndex) => (
                        <div key={spIndex} className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300 leading-relaxed mb-2 last:mb-0">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{subParagraph}</ReactMarkdown>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default GuidePage; 