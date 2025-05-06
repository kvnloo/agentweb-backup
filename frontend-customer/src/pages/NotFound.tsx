import { useLocation } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error(
      "404 Error: Customer attempted to access non-existent route:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">404</h1>
        <p className="text-xl text-gray-600 mb-4">Oops! Page not found</p>
        <div className="space-y-2">
          <a href="/" className="text-[#7E69AB] hover:text-[#6B46C1] underline block">
            Return to Dashboard
          </a>
          <a href="/login" className="text-[#7E69AB] hover:text-[#6B46C1] underline block">
            Return to Login
          </a>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
