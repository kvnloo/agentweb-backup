import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth, AuthErrorCode } from "../contexts/AuthContext";
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
import axios from "axios";
import { buildApiUrl } from "@/config";

const Register = () => {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [isEmailFromStripe, setIsEmailFromStripe] = useState(false);
  const [stripeSessionData, setStripeSessionData] = useState<any>(null);
  const hasTrackedPurchaseRef = useRef(false);
  const { error, register, errorCode, landingSiteUrl } = useAuth();
  const navigate = useNavigate();

  // Pre-fill email from URL params (session_id or email)
  useEffect(() => {
    const sessionId = searchParams.get("session_id");
    const emailParam = searchParams.get("email");

    if (sessionId) {
      setIsLoading(true);
      axios
        .get(buildApiUrl(`/api/stripe/session/${sessionId}`))
        .then((response) => {
          if (response.data && response.data.email) {
            // Store stripe session data for later use in Purchase tracking
            setStripeSessionData(response.data);

            if (response.data.existingUser === true) {
              // User already exists, redirect to login
              console.log(
                "User already exists, redirecting to login with email:",
                response.data.email
              );
              navigate(
                `/login?email=${encodeURIComponent(
                  response.data.email
                )}&info=payment_success&stripe_customer_id=${encodeURIComponent(
                  response.data.stripe_customer_id || ""
                )}`
              );
            } else {
              // New user or only on waitlist, pre-fill email for registration
              setEmail(response.data.email);
              setIsEmailFromStripe(true);
            }
          }
        })
        .catch((err) => {
          console.error(
            "Failed to fetch email/status from Stripe session:",
            err
          );
          // Potentially set formError here if the API call itself fails significantly
          // e.g., if (err.response && err.response.status === 404) { setFormError("Invalid payment session.") }
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else if (emailParam) {
      setEmail(emailParam);
    }
  }, [searchParams, navigate]); // Added navigate to dependency array

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setFormError("");

    if (password !== confirmPassword) {
      setFormError("Passwords do not match");
      setIsLoading(false);
      return;
    }

    try {
      await register(email, password);

      // Track Facebook Pixel Purchase event if user came from Stripe
      if (
        isEmailFromStripe &&
        stripeSessionData &&
        !hasTrackedPurchaseRef.current
      ) {
        trackPurchaseEvent();
        hasTrackedPurchaseRef.current = true;
      }

      navigate("/");
    } catch (err) {
      // Error is already handled in the auth context
    } finally {
      setIsLoading(false);
    }
  };

  // Track Facebook Pixel Purchase event
  const trackPurchaseEvent = () => {
    // Check if Facebook Pixel is available
    if (typeof window !== "undefined" && window.fbq) {
      const fbq = window.fbq;

      try {
        // Track Purchase event with Stripe session data
        fbq("track", "Purchase", {
          value: stripeSessionData?.amount_total
            ? stripeSessionData.amount_total / 100
            : undefined, // Convert from cents to dollars
          currency: stripeSessionData?.currency || "USD",
          content_name: "AgentWeb Subscription",
          content_category: "Software Subscription",
          num_items: 1,
          customer_email: email,
          stripe_session_id:
            stripeSessionData?.stripe_session_id ||
            searchParams.get("session_id"),
          source: "stripe_checkout",
        });

        console.log(
          "Facebook Pixel Purchase event tracked for Stripe conversion"
        );
      } catch (error) {
        console.error("Failed to track Facebook Pixel Purchase event:", error);
      }
    } else {
      console.warn("Facebook Pixel not available for Purchase tracking");
    }
  };

  // Format the error message for display
  const getErrorMessage = () => {
    if (formError) {
      return formError;
    }

    if (error) {
      // Specifically ignore errors that indicate a general unauthenticated state
      // or session issues, as these are expected on a register page for a new user.
      // Only show errors that are relevant to the registration attempt itself (e.g., from the register function call).
      const ignorableErrorMessages = [
        "Session validation failed. Please log in again.",
        "Failed to load user data. Session may be invalid.",
        "No token provided", // If your API or context might set this
        "User not found", // If context sets this generally before registration attempt
        "Invalid token", // If context sets this
      ];

      // Also, consider ignoring if errorCode is a generic auth one not specific to registration problems
      const ignorableErrorCodes: (AuthErrorCode | null)[] = [
        "server_error",
        "access_denied",
      ]; // Initially, but not if it's from a failed register() call

      // If the error is one of the generic unauthenticated messages and there isn't a specific registration-related errorCode,
      // it's likely from the initial AuthContext load and should be ignored on the Register page.
      // However, if an error occurs *after* a registration attempt (which useAuth() also manages),
      // then `error` and `errorCode` will be updated by the register function in AuthContext, and those should be shown.
      // The current logic in AuthContext's register function re-throws the error, so `error` will be populated.

      if (
        ignorableErrorMessages.includes(error) &&
        (errorCode === null || ignorableErrorCodes.includes(errorCode)) &&
        !isLoading // Only ignore if not actively trying to submit (isLoading would be true during submit)
      ) {
        // This error is likely from initial load of AuthContext when no user is authenticated.
        // Don't show it on the register page unless it resulted from the actual registration attempt.
        // The register() call in AuthContext.tsx itself handles setting specific errors for registration failures.
        return null;
      }

      // For waitlist errors with URLs
      if (errorCode === "not_in_waitlist" && landingSiteUrl) {
        return (
          <>
            Please join our waitlist first at{" "}
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
      if (errorCode === "not_invited") {
        const discordInviteLink = "https://discord.gg/kP2u6Wf9KQ";

        return (
          <>
            <span className="font-semibold">Waitlist Status:</span> You're on
            our waitlist but not yet invited. Thanks for the waiting and we will
            send you an email when it is ready. You can also join our{" "}
            <a
              href={discordInviteLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline inline-flex items-center"
            >
              Discord Community <ExternalLink className="h-3 w-3 ml-1" />
            </a>{" "}
            for human support.
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
                  disabled={!isEmailFromStripe && !!searchParams.get("email")}
                  className="rounded-[8px] border border-[#7A6999] focus:border-[#ECAC5F] focus:shadow-[0_0_4px_#ECAC5F] transition-all duration-300 ease-in-out"
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
                  className="rounded-[8px] border border-[#7A6999] focus:border-[#ECAC5F] focus:shadow-[0_0_4px_#ECAC5F] transition-all duration-300 ease-in-out"
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
                {isLoading
                  ? "Creating account..."
                  : "Create account with Email"}
              </Button>
            </div>
          </form>
        </CardContent>
        <CardFooter className="flex justify-center">
          <div className="text-center">
            <Link
              to="/login"
              className="text-sm text-gray-300 hover:text-gray-100"
            >
              Already have an account? Sign in
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
};

export default Register;
