import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import { buildApiUrl } from "@/config";
import axios from "axios";
import { useLocation } from "react-router-dom";

export type UserRole = "customer" | "partner";

// Define general auth error codes type
export type AuthErrorCode =
  | "not_in_waitlist"
  | "not_invited"
  | "user_not_found"
  | "invalid_credentials"
  | "account_deactivated"
  | "server_error"
  | "access_denied"; // For general access issues

interface User {
  userId: string;
  email: string;
  roles: UserRole[];
  isAdmin: boolean;
  delegateInfo?: {
    isDelegated: boolean;
    adminEmail: string;
  };
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  logout: () => void;
  error: string | null;
  errorCode: AuthErrorCode | null;
  landingSiteUrl: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTokenState] = useState<string | null>(
    localStorage.getItem("token")
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);
  const [landingSiteUrl, setLandingSiteUrl] = useState<string | null>(null);

  // Get current location to reset errors on route change
  const location = useLocation();

  // Clear errors on route change
  useEffect(() => {
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);
  }, [location.pathname]);

  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setLoading(false);
        setUser(null); // Ensure user is null if no token
        return;
      }
      setLoading(true); // Set loading true before verification attempt
      setError(null); // Clear previous errors
      setErrorCode(null);

      try {
        const response = await axios.get(buildApiUrl("/api/auth/me"), {
          headers: { Authorization: `Bearer ${token}` },
        });

        const userData = response.data;
        if (!userData || !userData.userId || !userData.email) {
          console.error(
            "Invalid user data from /api/auth/me during initial load:",
            userData
          );
          setError("Failed to load user data. Session may be invalid.");
          setErrorCode("server_error");
          localStorage.removeItem("token"); // Clear bad token
          setTokenState(null);
          setUser(null);
          return; // Exit early
        }

        if (!userData.roles) userData.roles = [];

        if (!userData.isAdmin && !userData.roles.includes("customer")) {
          setError(
            "Access denied: Your account does not have permission to access this customer portal."
          );
          setErrorCode("access_denied");
          localStorage.removeItem("token");
          setTokenState(null);
          setUser(null);
        } else {
          setUser(userData);
        }
      } catch (err) {
        console.error("Token verification failed during initial load:", err);
        let message = "Session validation failed. Please log in again.";
        let code: AuthErrorCode | null = "server_error";

        if (err.response?.data) {
          message = err.response.data.message || message;
          code = (err.response.data.code as AuthErrorCode) || code;
        } else if (err.message) {
          message = err.message; // Could be a network error or other client-side issue
        }
        setError(message);
        if (code) setErrorCode(code);
        localStorage.removeItem("token"); // Critical: remove invalid token
        setTokenState(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    verifyToken();
  }, [token]); // Dependency array remains [token]

  const login = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);

    try {
      const response = await axios.post(buildApiUrl("/api/auth/login"), {
        email,
        password,
      });

      const { token: newToken, user: userData } = response.data;
      if (!userData.roles) userData.roles = [];

      if (!userData.isAdmin && !userData.roles.includes("customer")) {
        setError(
          "Access denied: You do not have permission to access this portal."
        );
        setErrorCode("access_denied");
        // Do not proceed to set token or user if access is denied here
        throw new Error(
          "Access denied: You do not have permission to access this portal."
        );
      }

      localStorage.setItem("token", newToken);
      setTokenState(newToken);
      setUser(userData);
    } catch (err) {
      console.error("Login failed:", err);
      let message = "Authentication failed. Please try again.";
      let code: AuthErrorCode | null = null;

      if (err.response?.data) {
        message = err.response.data.message || message;
        code = (err.response.data.code as AuthErrorCode) || null;
      } else if (
        err.message ===
        "Access denied: You do not have permission to access this portal."
      ) {
        // Handle the error thrown locally for role denial
        message = err.message;
        code = "access_denied";
      }

      setError(message);
      if (code) setErrorCode(code);

      throw err;
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);

    try {
      const response = await axios.post(buildApiUrl("/api/auth/register"), {
        email,
        password,
        roles: ["customer"],
      });

      const { token: newToken, user: userData } = response.data;
      if (!userData.roles) userData.roles = [];

      if (!userData.isAdmin && !userData.roles.includes("customer")) {
        setError("Access denied: Account created without customer role.");
        setErrorCode("access_denied");
        throw new Error(
          "Access denied: Account created without customer role."
        );
      }

      localStorage.setItem("token", newToken);
      setTokenState(newToken);
      setUser(userData);
    } catch (err) {
      console.error("Registration failed:", err);
      let message = "Registration failed. Please try again.";
      let code: AuthErrorCode | null = null;

      if (err.response?.data) {
        message = err.response.data.message || message;
        code = (err.response.data.code as AuthErrorCode) || null;

        if (code === "not_in_waitlist") {
          const msg = err.response?.data?.message || "";
          const urlMatch = msg.match(/at\s(.+)$/);
          if (urlMatch && urlMatch[1]) {
            setLandingSiteUrl(urlMatch[1].trim());
          }
        }
      } else if (
        err.message === "Access denied: Account created without customer role."
      ) {
        message = err.message;
        code = "access_denied";
      }

      setError(message);
      if (code) setErrorCode(code);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const loginWithGoogle = async () => {
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);

    try {
      // Redirect to Google OAuth endpoint
      const googleAuthUrl = buildApiUrl("/api/auth/google");
      console.log("Redirecting to Google OAuth:", googleAuthUrl);

      // Add a customer role parameter to indicate this is from the customer portal
      const redirectUrl = `${googleAuthUrl}?portal=customer`;
      window.location.href = redirectUrl;
    } catch (error) {
      console.error("Google sign in failed:", error);

      if (error.response?.data?.message) {
        setError(error.response.data.message);
      } else {
        setError("Google sign in failed. Please try again.");
      }

      if (error.response?.data?.code) {
        setErrorCode(error.response.data.code as AuthErrorCode);
      }

      throw error;
    }
  };

  const setToken = async (newToken: string) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);

    try {
      const response = await axios.get(buildApiUrl("/api/auth/me"), {
        headers: { Authorization: `Bearer ${newToken}` },
      });

      const userData = response.data;
      if (!userData || !userData.userId || !userData.email) {
        console.error(
          "Invalid user data received from /api/auth/me:",
          userData
        );
        setError("Invalid user data received after authentication.");
        setErrorCode("server_error"); // Or a new specific code like 'invalid_user_data'
        throw new Error("Invalid user data received after authentication.");
      }

      if (!userData.roles) userData.roles = []; // Ensure roles array exists

      if (!userData.isAdmin && !userData.roles.includes("customer")) {
        setError(
          "Access denied: Your account does not have permission to access this customer portal."
        );
        setErrorCode("access_denied");
        // No need to setLoading(false) here, finally block will do it.
        // Clear token and user immediately
        localStorage.removeItem("token");
        setTokenState(null);
        setUser(null);
        throw new Error(
          "Access denied: Your account does not have permission to access this customer portal."
        );
      }

      localStorage.setItem("token", newToken);
      setTokenState(newToken);
      setUser(userData);
    } catch (err) {
      console.error(
        "Error in setToken (validating /api/auth/me or role check):",
        err
      );
      let message = "Authentication token validation failed. Please try again.";
      let code: AuthErrorCode | null = "server_error"; // Default to server_error

      if (err.message && err.message.startsWith("Access denied")) {
        // This catches the error thrown explicitly for role denial
        message = err.message;
        code = "access_denied";
      } else if (err.response?.data) {
        // Error from axios request to /api/auth/me
        message = err.response.data.message || message;
        code = (err.response.data.code as AuthErrorCode) || code;
      } else if (err.message) {
        // Other JS errors that might occur
        message = err.message;
      }

      setError(message);
      if (code) setErrorCode(code);

      // Critical: Clear potentially bad token if validation failed for reasons other than explicit role denial
      // If it was role denial, token was already cleared above.
      if (code !== "access_denied") {
        localStorage.removeItem("token");
        setTokenState(null);
        setUser(null);
      }
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem("token");
    setTokenState(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user,
        loading,
        login,
        register,
        loginWithGoogle,
        setToken,
        logout,
        error,
        errorCode,
        landingSiteUrl,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
