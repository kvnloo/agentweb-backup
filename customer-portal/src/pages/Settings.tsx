import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { PlusCircle, Trash2, Save, UserCircle } from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import axios from "axios";
import { buildApiUrl } from "@/config";

interface Account {
  id: string;
  service: string;
  username: string;
  password: string;
  url: string;
}

interface BrandGuidelines {
  brandName: string;
  tagline: string;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  toneOfVoice: string;
  keyMessages: string[];
  brandValues: string[];
  targetAudience: string;
  brandPersonality: string;
}

interface BrandAssets {
  logo: File | null;
  secondaryLogo: File | null;
  brandGuide: File | null;
}

interface ExistingAsset {
  type: string;
  filename: string;
  url: string;
  key: string;
}

function Settings() {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([
    {
      id: "1",
      service: "Twitter",
      username: "marketingops",
      password: "********",
      url: "https://twitter.com",
    },
    {
      id: "2",
      service: "LinkedIn",
      username: "marketing.team",
      password: "********",
      url: "https://linkedin.com",
    },
  ]);

  const [newAccount, setNewAccount] = useState<Omit<Account, "id">>({
    service: "",
    username: "",
    password: "",
    url: "",
  });

  // Brand Guidelines state
  const [brandGuidelines, setBrandGuidelines] = useState<BrandGuidelines>({
    brandName: "",
    tagline: "",
    primaryColor: "#000000",
    secondaryColor: "#ffffff",
    fontFamily: "",
    toneOfVoice: "",
    keyMessages: [],
    brandValues: [],
    targetAudience: "",
    brandPersonality: "",
  });

  const [brandAssets, setBrandAssets] = useState<BrandAssets>({
    logo: null,
    secondaryLogo: null,
    brandGuide: null,
  });

  const [existingAssets, setExistingAssets] = useState<ExistingAsset[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Initialize display name from user email when component mounts
  useEffect(() => {
    if (user?.email) {
      // Extract name from email (before @)
      const name = user.email.split("@")[0];
      // Capitalize first letter and replace dots/underscores with spaces
      const formattedName = name
        .split(/[._-]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");

      setDisplayName(formattedName);
    }
  }, [user]);

  const getInitials = (email: string) => {
    if (!email) return "CU";
    const parts = email.split("@")[0].split(/[._-]/);
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
        variant: "destructive",
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
    setAccounts(accounts.filter((account) => account.id !== id));
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

  // Load existing brand guidelines
  useEffect(() => {
    const loadBrandGuidelines = async () => {
      try {
        const token = localStorage.getItem("token");
        if (!token) return;

        const response = await axios.get(buildApiUrl("/api/brand/guidelines"), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.data.exists) {
          const data = response.data;
          setBrandGuidelines({
            brandName: data.brandData?.brandName || "",
            tagline: data.brandData?.tagline || "",
            primaryColor: data.brandData?.primaryColor || "#000000",
            secondaryColor: data.brandData?.secondaryColor || "#ffffff",
            fontFamily: data.brandData?.fontFamily || "",
            toneOfVoice: data.brandData?.toneOfVoice || "",
            keyMessages: data.brandData?.keyMessages || [],
            brandValues: data.brandData?.brandValues || [],
            targetAudience: data.brandData?.targetAudience || "",
            brandPersonality: data.brandData?.brandPersonality || "",
          });
          setExistingAssets(data.attachments || []);
        }
      } catch (error) {
        console.error("Error loading brand guidelines:", error);
      }
    };

    loadBrandGuidelines();
  }, []);

  const handleFileChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    fileType: keyof BrandAssets
  ) => {
    const file = e.target.files?.[0];
    if (file) {
      setBrandAssets({ ...brandAssets, [fileType]: file });
    }
  };

  const deleteAsset = async (key: string) => {
    try {
      const token = localStorage.getItem("token");
      if (!token) return;

      await axios.delete(
        buildApiUrl(`/api/brand/guidelines/asset/${encodeURIComponent(key)}`),
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      setExistingAssets(existingAssets.filter((asset) => asset.key !== key));
      toast({
        title: "Asset Deleted",
        description: "Brand asset has been removed successfully.",
      });
    } catch (error) {
      console.error("Error deleting asset:", error);
      toast({
        title: "Error",
        description: "Failed to delete asset. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleSaveBrandGuidelines = async () => {
    try {
      setIsSaving(true);
      const token = localStorage.getItem("token");
      if (!token) {
        toast({
          title: "Error",
          description: "Please log in to save brand guidelines.",
          variant: "destructive",
        });
        return;
      }

      const formData = new FormData();

      // Add brand data
      Object.entries(brandGuidelines).forEach(([key, value]) => {
        if (key === "keyMessages" || key === "brandValues") {
          formData.append(key, JSON.stringify(value));
        } else {
          formData.append(key, value as string);
        }
      });

      // Add files
      if (brandAssets.logo) {
        formData.append("logo", brandAssets.logo);
      }
      if (brandAssets.secondaryLogo) {
        formData.append("secondaryLogo", brandAssets.secondaryLogo);
      }
      if (brandAssets.brandGuide) {
        formData.append("brandGuide", brandAssets.brandGuide);
      }

      await axios.post(buildApiUrl("/api/brand/guidelines"), formData, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "multipart/form-data",
        },
      });

      // Clear file inputs
      setBrandAssets({
        logo: null,
        secondaryLogo: null,
        brandGuide: null,
      });

      // Reload the page to refresh existing assets
      window.location.reload();

      toast({
        title: "Success",
        description: "Brand guidelines saved successfully!",
      });
    } catch (error) {
      console.error("Error saving brand guidelines:", error);
      toast({
        title: "Error",
        description: "Failed to save brand guidelines. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="w-full space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account and preferences
        </p>
      </div>

      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="mb-4 bg-transparent p-0 gap-2">
          <TabsTrigger
            value="profile"
            className="data-[state=active]:tab-gradient data-[state=active]:text-white data-[state=active]:font-semibold data-[state=active]:shadow-md 
                       data-[state=inactive]:bg-white/10 data-[state=inactive]:dark:bg-black/20 data-[state=inactive]:text-white/70 data-[state=inactive]:dark:text-white/50 
                       hover:data-[state=inactive]:bg-white/20 hover:data-[state=inactive]:dark:hover:bg-black/30 hover:data-[state=inactive]:text-white/90 hover:data-[state=inactive]:dark:hover:text-white/70
                       rounded-full whitespace-nowrap px-4 py-2 transition-all duration-200 focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            Profile
          </TabsTrigger>
          <TabsTrigger
            value="accounts"
            className="data-[state=active]:tab-gradient data-[state=active]:text-white data-[state=active]:font-semibold data-[state=active]:shadow-md 
                       data-[state=inactive]:bg-white/10 data-[state=inactive]:dark:bg-black/20 data-[state=inactive]:text-white/70 data-[state=inactive]:dark:text-white/50 
                       hover:data-[state=inactive]:bg-white/20 hover:data-[state=inactive]:dark:hover:bg-black/30 hover:data-[state=inactive]:text-white/90 hover:data-[state=inactive]:dark:hover:text-white/70
                       rounded-full whitespace-nowrap px-4 py-2 transition-all duration-200 focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            Connected Accounts
          </TabsTrigger>
          <TabsTrigger
            value="preferences"
            className="data-[state=active]:tab-gradient data-[state=active]:text-white data-[state=active]:font-semibold data-[state=active]:shadow-md 
                       data-[state=inactive]:bg-white/10 data-[state=inactive]:dark:bg-black/20 data-[state=inactive]:text-white/70 data-[state=inactive]:dark:text-white/50 
                       hover:data-[state=inactive]:bg-white/20 hover:data-[state=inactive]:dark:hover:bg-black/30 hover:data-[state=inactive]:text-white/90 hover:data-[state=inactive]:dark:hover:text-white/70
                       rounded-full whitespace-nowrap px-4 py-2 transition-all duration-200 focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            Preferences
          </TabsTrigger>
          <TabsTrigger
            value="brand"
            className="data-[state=active]:tab-gradient data-[state=active]:text-white data-[state=active]:font-semibold data-[state=active]:shadow-md 
                       data-[state=inactive]:bg-white/10 data-[state=inactive]:dark:bg-black/20 data-[state=inactive]:text-white/70 data-[state=inactive]:dark:text-white/50 
                       hover:data-[state=inactive]:bg-white/20 hover:data-[state=inactive]:dark:hover:bg-black/30 hover:data-[state=inactive]:text-white/90 hover:data-[state=inactive]:dark:hover:text-white/70
                       rounded-full whitespace-nowrap px-4 py-2 transition-all duration-200 focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            Brand Guidelines
          </TabsTrigger>
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
                    {user?.roles?.includes("customer")
                      ? "Customer Account"
                      : "Partner Account"}
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
                  <Input id="email" value={user?.email} disabled />
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button
                className="use-template-button"
                onClick={handleSavePreferences}
              >
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
              <CardDescription>
                Add services for the agent to access
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="service">Service</Label>
                  <Input
                    id="service"
                    placeholder="Twitter, LinkedIn, etc."
                    value={newAccount.service}
                    onChange={(e) =>
                      setNewAccount({ ...newAccount, service: e.target.value })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    placeholder="Username or Email"
                    value={newAccount.username}
                    onChange={(e) =>
                      setNewAccount({ ...newAccount, username: e.target.value })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Password"
                    value={newAccount.password}
                    onChange={(e) =>
                      setNewAccount({ ...newAccount, password: e.target.value })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="url">URL</Label>
                  <Input
                    id="url"
                    type="url"
                    placeholder="https://example.com"
                    value={newAccount.url}
                    onChange={(e) =>
                      setNewAccount({ ...newAccount, url: e.target.value })
                    }
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button
                className="use-template-button"
                onClick={handleAddAccount}
              >
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
                <p className="text-center text-muted-foreground py-4">
                  No accounts connected yet.
                </p>
              ) : (
                <div className="space-y-4">
                  {accounts.map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div>
                        <h3 className="font-medium">{account.service}</h3>
                        <p className="text-sm text-muted-foreground">
                          {account.username}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {account.url ? (
                            <a
                              href={account.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {account.url.replace(/(^\w+:|^)\/\//, "")}
                            </a>
                          ) : (
                            "No URL provided"
                          )}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteAccount(account.id)}
                      >
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
                  <input
                    type="checkbox"
                    id="email-notifications"
                    className="h-4 w-4"
                  />
                  <Label
                    htmlFor="email-notifications"
                    className="text-sm font-normal"
                  >
                    Receive email notifications for completed tasks
                  </Label>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button
                className="use-template-button"
                onClick={handleSavePreferences}
              >
                <Save className="mr-2 h-4 w-4" />
                Save Preferences
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="brand" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Brand Guidelines</CardTitle>
              <CardDescription>
                Define your brand identity to ensure consistent messaging across
                all AI-generated content
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="brandName">Brand Name</Label>
                    <Input
                      id="brandName"
                      placeholder="Your company name"
                      value={brandGuidelines.brandName}
                      onChange={(e) =>
                        setBrandGuidelines({
                          ...brandGuidelines,
                          brandName: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div>
                    <Label htmlFor="tagline">Tagline</Label>
                    <Input
                      id="tagline"
                      placeholder="Your brand tagline"
                      value={brandGuidelines.tagline}
                      onChange={(e) =>
                        setBrandGuidelines({
                          ...brandGuidelines,
                          tagline: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div>
                    <Label htmlFor="primaryColor">Primary Color</Label>
                    <div className="flex gap-2">
                      <Input
                        id="primaryColor"
                        type="color"
                        value={brandGuidelines.primaryColor}
                        onChange={(e) =>
                          setBrandGuidelines({
                            ...brandGuidelines,
                            primaryColor: e.target.value,
                          })
                        }
                        className="w-20 h-10"
                      />
                      <Input
                        placeholder="#000000"
                        value={brandGuidelines.primaryColor}
                        onChange={(e) =>
                          setBrandGuidelines({
                            ...brandGuidelines,
                            primaryColor: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="secondaryColor">Secondary Color</Label>
                    <div className="flex gap-2">
                      <Input
                        id="secondaryColor"
                        type="color"
                        value={brandGuidelines.secondaryColor}
                        onChange={(e) =>
                          setBrandGuidelines({
                            ...brandGuidelines,
                            secondaryColor: e.target.value,
                          })
                        }
                        className="w-20 h-10"
                      />
                      <Input
                        placeholder="#ffffff"
                        value={brandGuidelines.secondaryColor}
                        onChange={(e) =>
                          setBrandGuidelines({
                            ...brandGuidelines,
                            secondaryColor: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="fontFamily">Font Family</Label>
                    <Input
                      id="fontFamily"
                      placeholder="Arial, Helvetica, sans-serif"
                      value={brandGuidelines.fontFamily}
                      onChange={(e) =>
                        setBrandGuidelines({
                          ...brandGuidelines,
                          fontFamily: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label htmlFor="toneOfVoice">Tone of Voice</Label>
                    <Input
                      id="toneOfVoice"
                      placeholder="Professional, friendly, casual..."
                      value={brandGuidelines.toneOfVoice}
                      onChange={(e) =>
                        setBrandGuidelines({
                          ...brandGuidelines,
                          toneOfVoice: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div>
                    <Label htmlFor="targetAudience">Target Audience</Label>
                    <Input
                      id="targetAudience"
                      placeholder="Small business owners, enterprises..."
                      value={brandGuidelines.targetAudience}
                      onChange={(e) =>
                        setBrandGuidelines({
                          ...brandGuidelines,
                          targetAudience: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div>
                    <Label htmlFor="brandPersonality">Brand Personality</Label>
                    <Input
                      id="brandPersonality"
                      placeholder="Innovative, trustworthy, energetic..."
                      value={brandGuidelines.brandPersonality}
                      onChange={(e) =>
                        setBrandGuidelines({
                          ...brandGuidelines,
                          brandPersonality: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div>
                    <Label>Key Messages</Label>
                    <div className="space-y-2">
                      {brandGuidelines.keyMessages.map((message, index) => (
                        <div key={index} className="flex gap-2">
                          <Input
                            placeholder="Key message"
                            value={message}
                            onChange={(e) => {
                              const newMessages = [
                                ...brandGuidelines.keyMessages,
                              ];
                              newMessages[index] = e.target.value;
                              setBrandGuidelines({
                                ...brandGuidelines,
                                keyMessages: newMessages,
                              });
                            }}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const newMessages =
                                brandGuidelines.keyMessages.filter(
                                  (_, i) => i !== index
                                );
                              setBrandGuidelines({
                                ...brandGuidelines,
                                keyMessages: newMessages,
                              });
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        onClick={() =>
                          setBrandGuidelines({
                            ...brandGuidelines,
                            keyMessages: [...brandGuidelines.keyMessages, ""],
                          })
                        }
                      >
                        <PlusCircle className="mr-2 h-4 w-4" />
                        Add Message
                      </Button>
                    </div>
                  </div>

                  <div>
                    <Label>Brand Values</Label>
                    <div className="space-y-2">
                      {brandGuidelines.brandValues.map((value, index) => (
                        <div key={index} className="flex gap-2">
                          <Input
                            placeholder="Brand value"
                            value={value}
                            onChange={(e) => {
                              const newValues = [
                                ...brandGuidelines.brandValues,
                              ];
                              newValues[index] = e.target.value;
                              setBrandGuidelines({
                                ...brandGuidelines,
                                brandValues: newValues,
                              });
                            }}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const newValues =
                                brandGuidelines.brandValues.filter(
                                  (_, i) => i !== index
                                );
                              setBrandGuidelines({
                                ...brandGuidelines,
                                brandValues: newValues,
                              });
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        onClick={() =>
                          setBrandGuidelines({
                            ...brandGuidelines,
                            brandValues: [...brandGuidelines.brandValues, ""],
                          })
                        }
                      >
                        <PlusCircle className="mr-2 h-4 w-4" />
                        Add Value
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <Label>Brand Assets</Label>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="logo">Logo</Label>
                    <Input
                      id="logo"
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleFileChange(e, "logo")}
                    />
                    {brandAssets.logo && (
                      <div className="mt-2 p-2 bg-gray-50 rounded flex items-center justify-between">
                        <span className="text-sm truncate">
                          {brandAssets.logo.name}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setBrandAssets({ ...brandAssets, logo: null })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <div>
                    <Label htmlFor="secondaryLogo">Secondary Logo</Label>
                    <Input
                      id="secondaryLogo"
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleFileChange(e, "secondaryLogo")}
                    />
                    {brandAssets.secondaryLogo && (
                      <div className="mt-2 p-2 bg-gray-50 rounded flex items-center justify-between">
                        <span className="text-sm truncate">
                          {brandAssets.secondaryLogo.name}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setBrandAssets({
                              ...brandAssets,
                              secondaryLogo: null,
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <div>
                    <Label htmlFor="brandGuide">Brand Guide Document</Label>
                    <Input
                      id="brandGuide"
                      type="file"
                      accept=".pdf,.doc,.docx"
                      onChange={(e) => handleFileChange(e, "brandGuide")}
                    />
                    {brandAssets.brandGuide && (
                      <div className="mt-2 p-2 bg-gray-50 rounded flex items-center justify-between">
                        <span className="text-sm truncate">
                          {brandAssets.brandGuide.name}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setBrandAssets({ ...brandAssets, brandGuide: null })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {existingAssets.length > 0 && (
                  <div>
                    <Label>Existing Assets</Label>
                    <div className="space-y-2">
                      {existingAssets.map((asset, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-2 bg-gray-50 rounded"
                        >
                          <div>
                            <span className="font-medium">{asset.type}: </span>
                            <span className="text-sm">{asset.filename}</span>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => window.open(asset.url, "_blank")}
                            >
                              View
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => deleteAsset(asset.key)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
            <CardFooter>
              <Button
                className="use-template-button"
                onClick={handleSaveBrandGuidelines}
                disabled={isSaving}
              >
                <Save className="mr-2 h-4 w-4" />
                {isSaving ? "Saving..." : "Save Brand Guidelines"}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default Settings;
