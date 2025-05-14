import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, ExternalLink } from 'lucide-react';

// Define error structure from backend
interface AuthError {
  statusCode?: number;
  message: string;
  code?: string;
}

const OAuthCallback = () => {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [landingSiteUrl, setLandingSiteUrl] = useState<string | null>(null);
  const { setToken, error: authError } = useAuth();
  const navigate = useNavigate();
  // Use a ref to track if we've attempted authentication
  const authAttempted = useRef(false);

  useEffect(() => {
    // If we've already shown an error or attempted auth, don't try again
    if (error || authAttempted.current) {
      return;
    }
    
    const token = searchParams.get('token');
    
    const processOAuthResponse = async () => {
      if (!token) {
        setError('No authentication token received');
        return;
      }
      
      // Mark that we've attempted auth to prevent loops
      authAttempted.current = true;
      
      try {
        await setToken(token);
        navigate('/');
      } catch (err: any) {
        console.error('Error processing OAuth callback:', err);
        
        // Parse and handle structured error objects
        if (err?.response?.data) {
          const errData = err.response.data;
          
          // Extract message
          setError(errData.message || 'Authentication failed');
          
          // Extract error code if available
          if (errData.code) {
            setErrorCode(errData.code);
          }
          
          // Extract landing site URL from error message for waitlist errors
          if (errData.code === 'not_in_waitlist' && errData.message) {
            const match = errData.message.match(/(https?:\/\/[^\s]+)/);
            if (match && match[0]) {
              setLandingSiteUrl(match[0]);
            }
          }
        } else if (authError) {
          // Use error from auth context
          setError(authError);
        } else if (err instanceof Error) {
          // Standard JS error object
          setError(err.message);
        } else {
          // Fallback
          setError('Failed to authenticate. Please try again.');
        }
      }
    };
    
    processOAuthResponse();
  }, [searchParams, setToken, navigate, authError, error]);

  // Immediately show error from URL if present
  useEffect(() => {
    const urlError = searchParams.get('error');
    const urlCode = searchParams.get('code');
    
    if (urlError) {
      setError(urlError === 'google_auth_failed' ? 
        'Google authentication failed. Please try again.' : 
        urlError);
        
      if (urlCode) {
        setErrorCode(urlCode);
        
        // For waitlist errors, also extract landing site URL if present
        if (urlCode === 'not_in_waitlist' && urlError) {
          const match = urlError.match(/(https?:\/\/[^\s]+)/);
          if (match && match[0]) {
            setLandingSiteUrl(match[0]);
          }
        }
      }
    }
  }, [searchParams]);

  // Format the error message for display
  const getFormattedError = () => {
    if (!error) return null;
    
    // For waitlist errors with URLs
    if (errorCode === 'not_in_waitlist' && landingSiteUrl) {
      return (
        <>
          Please join our waitlist first at{' '}
          <a 
            href={landingSiteUrl} 
            target="_blank" 
            rel="noopener noreferrer" 
            className="text-blue-600 hover:underline inline-flex items-center"
          >
            {landingSiteUrl} <ExternalLink className="h-3 w-3 ml-1" />
          </a>
        </>
      );
    }
    
    // For invitation pending errors
    if (errorCode === 'not_invited') {
      const discordInviteLink = "https://discord.gg/agentweb"; // Replace with your actual Discord invite link
      
      return (
        <>
          <span className="font-semibold">Waitlist Status:</span> You're on our waitlist but not yet invited. 
          Thanks for the waiting and we will send you an email when it is ready. 
          You can also join our{' '}
          <a 
            href={discordInviteLink}
            target="_blank" 
            rel="noopener noreferrer" 
            className="text-blue-600 hover:underline inline-flex items-center"
          >
            Discord Community <ExternalLink className="h-3 w-3 ml-1" />
          </a>
          {' '}for human support.
        </>
      );
    }
    
    // For role errors
    if (errorCode === 'invalid_role') {
      return 'Your account does not have access to this portal. Please contact support if you believe this is an error.';
    }
    
    // For any other errors, show them directly
    return error;
  };

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center flex-col">
        <div className="text-xl font-semibold mb-2 text-red-500">Authentication Error</div>
        <p className="text-muted-foreground mb-4" style={{ maxWidth: '80%', textAlign: 'center' }}>
          {getFormattedError()}
        </p>
        <button
          onClick={() => navigate('/login')}
          className="px-4 py-2 bg-[#7E69AB] text-white rounded-md hover:bg-[#6B46C1]"
        >
          Return to Login
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center flex-col">
      <Loader2 className="h-8 w-8 animate-spin text-[#7E69AB] mb-4" />
      <p className="text-muted-foreground">Completing authentication...</p>
    </div>
  );
};

export default OAuthCallback; 