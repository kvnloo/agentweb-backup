import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { PlusCircle, Trash2, Save, UserCircle } from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface Account {
  id: string;
  service: string;
  username: string;
  password: string;
  url: string;
}

function Settings() {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([
    { id: "1", service: "Twitter", username: "marketingops", password: "********", url: "https://twitter.com" },
    { id: "2", service: "LinkedIn", username: "marketing.team", password: "********", url: "https://linkedin.com" }
  ]);
  
  const [newAccount, setNewAccount] = useState<Omit<Account, "id">>({
    service: "",
    username: "",
    password: "",
    url: ""
  });
  
  // Initialize display name from user email when component mounts
  useEffect(() => {
    if (user?.email) {
      // Extract name from email (before @)
      const name = user.email.split('@')[0];
      // Capitalize first letter and replace dots/underscores with spaces
      const formattedName = name
        .split(/[._-]/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      
      setDisplayName(formattedName);
    }
  }, [user]);
  
  const getInitials = (email: string) => {
    if (!email) return 'CU';
    const parts = email.split('@')[0].split(/[._-]/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  };
  
  const handleAddAccount = () => {
    if (!newAccount.service || !newAccount.username || !newAccount.password) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive"
      });
      return;
    }
    
    const newId = (accounts.length + 1).toString();
    setAccounts([...accounts, { ...newAccount, id: newId }]);
    setNewAccount({ service: "", username: "", password: "", url: "" });
    
    toast({
      title: "Success",
      description: "Account added successfully",
    });
  };
  
  const handleDeleteAccount = (id: string) => {
    setAccounts(accounts.filter(account => account.id !== id));
    toast({
      title: "Account Removed",
      description: "The account has been removed successfully.",
    });
  };

  const handleSavePreferences = () => {
    toast({
      title: "Preferences Saved",
      description: "Your preferences have been updated successfully.",
    });
  };

  return (
    <div className="w-full space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="accounts">Connected Accounts</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>
        
        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Your Profile</CardTitle>
              <CardDescription>Manage your account details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-col sm:flex-row gap-4 items-center">
                <Avatar className="h-20 w-20">
                  <AvatarFallback className="text-xl bg-[#F3EFFD] text-[#7E69AB]">
                    {user && getInitials(user.email)}
                  </AvatarFallback>
                </Avatar>
                
                <div className="space-y-1">
                  <h3 className="text-xl font-semibold">{displayName}</h3>
                  <p className="text-sm text-muted-foreground">{user?.email}</p>
                  <p className="text-sm font-medium inline-block px-2 py-1 bg-[#F3EFFD] text-[#7E69AB] rounded-full">
                    {user?.role === 'customer' ? 'Customer Account' : 'Partner Account'}
                  </p>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="displayName">Display Name</Label>
                  <Input 
                    id="displayName" 
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address</Label>
                  <Input 
                    id="email" 
                    value={user?.email}
                    disabled
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button onClick={handleSavePreferences}>
                <Save className="mr-2 h-4 w-4" />
                Save Profile
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
        
        <TabsContent value="accounts" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Add New Account</CardTitle>
              <CardDescription>Add services for the agent to access</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="service">Service</Label>
                  <Input 
                    id="service" 
                    placeholder="Twitter, LinkedIn, etc."
                    value={newAccount.service}
                    onChange={(e) => setNewAccount({...newAccount, service: e.target.value})}
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input 
                    id="username" 
                    placeholder="Username or Email"
                    value={newAccount.username}
                    onChange={(e) => setNewAccount({...newAccount, username: e.target.value})}
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input 
                    id="password" 
                    type="password" 
                    placeholder="Password"
                    value={newAccount.password}
                    onChange={(e) => setNewAccount({...newAccount, password: e.target.value})}
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="url">URL</Label>
                  <Input 
                    id="url" 
                    type="url" 
                    placeholder="https://example.com"
                    value={newAccount.url}
                    onChange={(e) => setNewAccount({...newAccount, url: e.target.value})}
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button onClick={handleAddAccount}>
                <PlusCircle className="mr-2 h-4 w-4" />
                Add Account
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connected Accounts</CardTitle>
              <CardDescription>Accounts the agent can access</CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">No accounts connected yet.</p>
              ) : (
                <div className="space-y-4">
                  {accounts.map((account) => (
                    <div key={account.id} className="flex items-center justify-between p-4 border rounded-lg">
                      <div>
                        <h3 className="font-medium">{account.service}</h3>
                        <p className="text-sm text-muted-foreground">{account.username}</p>
                        <p className="text-sm text-muted-foreground">
                          {account.url ? (
                            <a href={account.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                              {account.url.replace(/(^\w+:|^)\/\//, '')}
                            </a>
                          ) : (
                            "No URL provided"
                          )}
                        </p>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => handleDeleteAccount(account.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        
        <TabsContent value="preferences" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>User Preferences</CardTitle>
              <CardDescription>Customize your experience</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Display Name</Label>
                <Input 
                  id="name" 
                  placeholder="Your Name" 
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="email-notifications">Email Notifications</Label>
                <div className="flex items-center space-x-2">
                  <input type="checkbox" id="email-notifications" className="h-4 w-4" />
                  <Label htmlFor="email-notifications" className="text-sm font-normal">
                    Receive email notifications for completed tasks
                  </Label>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button onClick={handleSavePreferences}>
                <Save className="mr-2 h-4 w-4" />
                Save Preferences
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default Settings; 