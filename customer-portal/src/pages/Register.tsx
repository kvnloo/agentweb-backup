import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import GoogleSignInButton from '@/components/auth/GoogleSignInButton';
import { Separator } from '@/components/ui/separator';

const Register = () => {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const { error, register, errorCode, landingSiteUrl } = useAuth();
  const navigate = useNavigate();

  // Pre-fill email from URL params
  useEffect(() => {
    const emailParam = searchParams.get('email');
    if (emailParam) {
      setEmail(emailParam);
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setFormError('');

    if (password !== confirmPassword) {
      setFormError('Passwords do not match');
      setIsLoading(false);
      return;
    }

    try {
      await register(email, password);
      navigate('/');
    } catch (err) {
      // Error is already handled in the auth context
    } finally {
      setIsLoading(false);
    }
  };

  // Format the error message for display
  const getErrorMessage = () => {
    if (formError) {
      return formError;
    }
    
    if (error) {
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
        const discordInviteLink = "https://discord.gg/yUCuSxHH";
        
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
      
      // For any other errors, show them directly
      return error;
    }
    
    return null;
  };

  const errorMessage = getErrorMessage();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F3EFFD] p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <div className="flex justify-center mb-4">
            <div className="h-12 w-12 rounded-md agent-gradient flex items-center justify-center">
              <span className="text-white font-bold text-2xl">A</span>
            </div>
          </div>
          <CardTitle className="text-2xl font-bold text-center">Customer Portal</CardTitle>
          <CardDescription className="text-center">
            Create an account to access the customer dashboard
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <GoogleSignInButton />
          
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <Separator className="w-full" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
            </div>
          </div>
          
          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="example@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={!!searchParams.get('email')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              
              {errorMessage && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="ml-2">
                    {errorMessage}
                  </AlertDescription>
                </Alert>
              )}
              
              <Button
                type="submit"
                className="w-full agent-gradient"
                disabled={isLoading}
              >
                {isLoading ? 'Creating account...' : 'Create account with Email'}
              </Button>
            </div>
          </form>
        </CardContent>
        <CardFooter className="flex justify-center">
          <div className="text-center">
            <Link to="/login" className="text-sm text-[#7E69AB] hover:text-[#6B46C1]">
              Already have an account? Sign in
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
};

export default Register; 