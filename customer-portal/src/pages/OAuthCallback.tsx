import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

const OAuthCallback = () => {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const { setToken } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const token = searchParams.get('token');
    
    const processOAuthResponse = async () => {
      if (!token) {
        setError('No authentication token received');
        return;
      }
      
      try {
        // In the main AuthContext, the setToken is used to validate and set the token
        // Since our customer AuthContext doesn't have this method, we'll need to add it
        await setToken(token);
        navigate('/');
      } catch (err) {
        console.error('Error processing OAuth callback:', err);
        setError('Failed to authenticate. Please try again.');
      }
    };
    
    processOAuthResponse();
  }, [searchParams, setToken, navigate]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center flex-col">
        <div className="text-xl font-semibold mb-2 text-red-500">Authentication Error</div>
        <p className="text-muted-foreground mb-4">{error}</p>
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