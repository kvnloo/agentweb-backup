import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Settings, LogOut, User, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { buildApiUrl } from "@/config";

const UserProfileDropdown = () => {
  const { user, logout, token } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isPortalLoading, setIsPortalLoading] = useState(false);

  if (!user) return null;

  const getInitials = (email: string) => {
    if (!email) return "CU";
    const parts = email.split("@");
    return parts[0].substring(0, 2).toUpperCase();
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const handleSettings = () => {
    navigate("/settings");
    setMenuOpen(false);
  };

  const handleCustomerPortalClick = async () => {
    if (!token) {
      console.error("No auth token found for customer portal request.");
      return;
    }
    setIsPortalLoading(true);
    try {
      const response = await axios.post(
        buildApiUrl("/api/stripe/create-customer-portal-session"),
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (response.data && response.data.url) {
        window.location.href = response.data.url;
      } else {
        console.error("Failed to retrieve Customer Portal URL.");
      }
    } catch (error) {
      console.error("Error creating Stripe Customer Portal session:", error);
    } finally {
      setIsPortalLoading(false);
      setMenuOpen(false);
    }
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full h-8 w-8 border border-[#D6BCFA]"
        >
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-[#F3EFFD] text-[#7E69AB]">
              {getInitials(user.email)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 p-2">
        <DropdownMenuLabel className="font-normal px-3 py-2">
          <div className="flex flex-col space-y-1">
            <p className="text-base font-medium leading-none">{user.email}</p>
            <p className="text-sm leading-none text-muted-foreground">
              {user.roles[0] === "customer"
                ? "Customer Account"
                : "Partner Account"}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleCustomerPortalClick}
          className="cursor-pointer px-3 py-2"
          disabled={isPortalLoading}
        >
          <CreditCard className="mr-3 h-5 w-5" />
          <span>{isPortalLoading ? "Loading..." : "Manage Billing"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleSettings}
          className="cursor-pointer px-3 py-2"
        >
          <Settings className="mr-3 h-5 w-5" />
          <span>Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          className="cursor-pointer px-3 py-2"
        >
          <LogOut className="mr-3 h-5 w-5" />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default UserProfileDropdown;
