import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertCircle, ExternalLink } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import GoogleSignInButton from "@/components/auth/GoogleSignInButton";
import { Separator } from "@/components/ui/separator";
import AgentWebLogo from "@/assets/AgentWeb-Logo-189x62.svg";

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { login, error, errorCode } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      // Error is already handled in the auth context
    } finally {
      setIsLoading(false);
    }
  };

  const getErrorMessage = () => {
    if (!error) return null;

    if (errorCode === "user_not_found") {
      return (
        <>
          {error}{" "}
          <Link to="/register" className="text-blue-600 hover:underline">
            Sign up here.
          </Link>
        </>
      );
    }

    return error;
  };

  const errorMessage = getErrorMessage();

  return (
    <div
      className="flex min-h-screen items-center justify-center p-4"
      style={{
        background:
          "linear-gradient(180deg, #1B2549 0%, #7A6999 50%, #ECAC5F 100%)",
      }}
    >
      <Card
        className="w-full max-w-md rounded-[24px] shadow-lg"
        style={{
          backgroundColor: "#1B2549",
          boxShadow: "0 0 20px rgba(100, 63, 126, 0.2)",
        }}
      >
        <CardHeader className="space-y-1">
          <div className="flex justify-center mb-4">
            <img src={AgentWebLogo} alt="AgentWeb Logo" className="h-10" />
          </div>
          <CardTitle
            className="text-2xl font-bold text-center text-white"
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "28px",
              fontWeight: 800,
              letterSpacing: "-0.5px",
            }}
          >
            Customer Portal
          </CardTitle>
          <CardDescription
            className="text-center"
            style={{ color: "rgba(255,255,255,0.8)" }}
          >
            Enter your credentials to access your customer dashboard
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <GoogleSignInButton />

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <Separator className="w-full" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="px-2 text-muted-foreground">
                Or continue with
              </span>
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
                  className="rounded-[8px] border border-[#7A6999] focus:border-[#ECAC5F] focus:shadow-[0_0_4px_#ECAC5F] transition-all duration-300 ease-in-out"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="rounded-[8px] border border-[#7A6999] focus:border-[#ECAC5F] focus:shadow-[0_0_4px_#ECAC5F] transition-all duration-300 ease-in-out"
                />
              </div>

              {errorMessage && (
                <Alert
                  variant="destructive"
                  className="bg-red-900 border-red-700 text-white"
                >
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="ml-2">
                    {errorMessage}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                className="w-full text-white font-bold py-[12px] hover:brightness-110 transition-all duration-300 ease-in-out"
                style={{
                  background:
                    "linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%)",
                }}
                disabled={isLoading}
              >
                {isLoading ? "Signing in..." : "Sign in with Email"}
              </Button>
            </div>
          </form>
        </CardContent>
        <CardFooter className="flex justify-center">
          <div className="text-center">
            <Link
              to="/register"
              className="text-sm text-gray-300 hover:text-gray-100"
            >
              Don't have an account? Sign up
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
};

export default Login;
