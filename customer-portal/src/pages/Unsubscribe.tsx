import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Alert, AlertDescription } from '../components/ui/alert';
import { CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { Textarea } from '../components/ui/textarea';
import axios from 'axios';
import { buildApiUrl } from '../config';

const UnsubscribePage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskName, setTaskName] = useState<string>('');
  const [subscriberEmail, setSubscriberEmail] = useState<string>('');
  const [feedback, setFeedback] = useState<string>('');

  const taskId = searchParams.get('taskId');
  const email = searchParams.get('email');

  useEffect(() => {
    if (!taskId || !email) {
      setError('Missing required parameters. Please use the unsubscribe link from your email.');
      return;
    }

    setSubscriberEmail(email);
    
    // Fetch task name and check current subscription status
    const fetchTaskAndStatus = async () => {
      try {
        // Fetch task name
        const taskResponse = await axios.get(buildApiUrl(`/api/tasks/${taskId}/name`));
        setTaskName(taskResponse.data.name || 'Unknown Task');
        
        // Check current subscription status
        const statusResponse = await axios.get(buildApiUrl(`/api/tasks/${taskId}/subscribers/${encodeURIComponent(email)}/status`));
        const subscriberData = statusResponse.data;
        
        // If already unsubscribed, show success state
        if (subscriberData.unsubscribed) {
          setSuccess(true);
        }
      } catch (err) {
        console.error('Failed to fetch task data or status:', err);
        setTaskName('Unknown Task');
      }
    };

    fetchTaskAndStatus();
  }, [taskId, email]);

  const handleUnsubscribe = async () => {
    if (!taskId || !email) return;

    setLoading(true);
    setError(null);

    try {
      await axios.post(buildApiUrl(`/api/tasks/${taskId}/unsubscribe`), {
        email: email,
        feedback: feedback
      });
      setSuccess(true);
    } catch (err: any) {
      console.error('Failed to unsubscribe:', err);
      setError(err.response?.data?.message || 'Failed to unsubscribe. Please try again or contact support.');
    } finally {
      setLoading(false);
    }
  };

  const handleResubscribe = async () => {
    if (!taskId || !email) return;

    setLoading(true);
    setError(null);

    try {
      await axios.post(buildApiUrl(`/api/tasks/${taskId}/resubscribe`), {
        email: email
      });
      setSuccess(false);
      setError(null);
    } catch (err: any) {
      console.error('Failed to resubscribe:', err);
      setError(err.response?.data?.message || 'Failed to resubscribe. Please try again or contact support.');
    } finally {
      setLoading(false);
    }
  };

  if (!taskId || !email) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center text-red-600">Invalid Unsubscribe Link</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                This unsubscribe link is invalid or has expired. Please use the unsubscribe link from your email.
              </AlertDescription>
            </Alert>
            <div className="mt-4 text-center">
              <a 
                href="/" 
                className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Powered by AgentWeb
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center text-green-600 flex items-center justify-center gap-2">
              <CheckCircle className="h-5 w-5" />
              Successfully Unsubscribed
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-center">
              <p className="text-gray-600 mb-2">
                You have been successfully unsubscribed from updates for:
              </p>
              <p className="font-semibold text-lg">{taskName}</p>
              <p className="text-sm text-gray-500 mt-1">{subscriberEmail}</p>
            </div>
            
            <Alert>
              <AlertDescription>
                You will no longer receive email notifications for this task. If you change your mind, you can resubscribe below.
              </AlertDescription>
            </Alert>

            <div className="flex gap-3">
              <Button 
                onClick={handleResubscribe} 
                disabled={loading}
                className="flex-1"
                variant="outline"
              >
                {loading ? 'Resubscribing...' : 'Resubscribe'}
              </Button>
            </div>
            
            <div className="text-center mt-4">
              <a 
                href="/" 
                className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Powered by AgentWeb
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-red-600 flex items-center justify-center gap-2">
            <XCircle className="h-5 w-5" />
            Unsubscribe from Task Updates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center">
            <p className="text-gray-600 mb-2">
              Are you sure you want to unsubscribe from updates for:
            </p>
            <p className="font-semibold text-lg">{taskName}</p>
            <p className="text-sm text-gray-500 mt-1">{subscriberEmail}</p>
          </div>
          
          <Alert>
            <AlertDescription>
              You will no longer receive email notifications when this task runs or completes. You can always resubscribe later if you change your mind.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <label htmlFor="feedback" className="text-sm font-medium text-gray-700">
              Optional Feedback (Why are you unsubscribing?)
            </label>
            <Textarea
              id="feedback"
              placeholder="Please let us know why you're unsubscribing. This helps us improve our service."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              className="min-h-[80px]"
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-3">
            <Button 
              onClick={handleUnsubscribe} 
              disabled={loading}
              className="flex-1"
              variant="destructive"
            >
              {loading ? 'Unsubscribing...' : 'Unsubscribe'}
            </Button>
          </div>
          
          <div className="text-center mt-4">
            <a 
              href="/" 
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Powered by AgentWeb
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default UnsubscribePage;
