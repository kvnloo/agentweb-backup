import { useState, useEffect } from "react";
import axios from "axios";
import { buildApiUrl } from "@/config";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Palette,
  Type,
  Image,
  Download,
  Edit3,
  Save,
  RotateCcw,
  FileText,
  MessageSquare,
  Users,
  Heart,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Define types for brand data
interface BrandData {
  brandName: string;
  tagline: string;
  primaryColor: string;
  primaryColorEnd: string;
  secondaryColor: string;
  fontFamily: string;
  toneOfVoice: string;
  keyMessages: string[];
  brandValues: string[];
  targetAudience: string;
  brandPersonality: string;
  isGradient: boolean;
}

interface BrandAssets {
  logo: File | null;
  secondaryLogo: File | null;
  brandGuide: File | null;
}

interface ExistingAsset {
  type: string;
  url: string;
  key: string;
  filename: string;
}

const BrandGuidelines = () => {
  const { toast } = useToast();

  // State for editing mode
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Brand data state
  const [brandData, setBrandData] = useState<BrandData>({
    brandName: "",
    tagline: "",
    primaryColor: "#7E69AB",
    primaryColorEnd: "#ECAC5F",
    secondaryColor: "#ECAC5F",
    fontFamily: "Inter",
    toneOfVoice: "",
    keyMessages: [],
    brandValues: [],
    targetAudience: "",
    brandPersonality: "",
    isGradient: true,
  });

  // Assets state
  const [brandAssets, setBrandAssets] = useState<BrandAssets>({
    logo: null,
    secondaryLogo: null,
    brandGuide: null,
  });

  const [existingAssets, setExistingAssets] = useState<ExistingAsset[]>([]);

  // Load existing brand guidelines
  useEffect(() => {
    const loadBrandGuidelines = async () => {
      try {
        console.log("[BRAND DEBUG] Loading brand guidelines...");
        const token = localStorage.getItem("token");
        if (!token) {
          console.log("[BRAND DEBUG] No token found");
          setIsLoading(false);
          return;
        }

        const response = await axios.get(buildApiUrl("/api/brand/guidelines"), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        console.log("[BRAND DEBUG] GET response:", response.data);

        if (response.data.exists) {
          const data = response.data;
          console.log(
            "[BRAND DEBUG] Brand guidelines exist, loading data:",
            data.brandData
          );
          setBrandData({
            brandName: data.brandData?.brandName || "",
            tagline: data.brandData?.tagline || "",
            primaryColor: data.brandData?.primaryColor || "#7E69AB",
            primaryColorEnd: data.brandData?.primaryColorEnd || "#ECAC5F",
            secondaryColor: data.brandData?.secondaryColor || "#ECAC5F",
            fontFamily: data.brandData?.fontFamily || "Inter",
            toneOfVoice: data.brandData?.toneOfVoice || "",
            keyMessages: data.brandData?.keyMessages || [],
            brandValues: data.brandData?.brandValues || [],
            targetAudience: data.brandData?.targetAudience || "",
            brandPersonality: data.brandData?.brandPersonality || "",
            isGradient: data.brandData?.isGradient || true,
          });
          setExistingAssets(data.attachments || []);
          console.log("[BRAND DEBUG] Brand guidelines loaded successfully");
        } else {
          console.log("[BRAND DEBUG] No existing brand guidelines found");
        }
      } catch (error) {
        console.error("[BRAND DEBUG] Error loading brand guidelines:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadBrandGuidelines();
  }, []);

  // Helper function to get proper font stack with fallbacks
  const getFontStack = (fontFamily: string) => {
    const fontStacks = {
      Inter:
        "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      Roboto:
        "'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "Open Sans":
        "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      Montserrat:
        "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      Poppins:
        "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      Lato: "'Lato', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      Arial: "'Arial', sans-serif",
      Helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      Georgia: "'Georgia', serif",
      "Times New Roman": "'Times New Roman', Times, serif",
    };
    return fontStacks[fontFamily as keyof typeof fontStacks] || fontFamily;
  };

  const handleFileChange = (field: keyof BrandAssets, file: File | null) => {
    setBrandAssets((prev) => ({
      ...prev,
      [field]: file,
    }));
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

      setExistingAssets((prev) => prev.filter((asset) => asset.key !== key));

      toast({
        title: "Success",
        description: "Asset deleted successfully!",
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

  const addKeyMessage = () => {
    setBrandData((prev) => ({
      ...prev,
      keyMessages: [...prev.keyMessages, ""],
    }));
  };

  const updateKeyMessage = (index: number, value: string) => {
    setBrandData((prev) => ({
      ...prev,
      keyMessages: prev.keyMessages.map((msg, i) =>
        i === index ? value : msg
      ),
    }));
  };

  const removeKeyMessage = (index: number) => {
    setBrandData((prev) => ({
      ...prev,
      keyMessages: prev.keyMessages.filter((_, i) => i !== index),
    }));
  };

  const addBrandValue = () => {
    setBrandData((prev) => ({
      ...prev,
      brandValues: [...prev.brandValues, ""],
    }));
  };

  const updateBrandValue = (index: number, value: string) => {
    setBrandData((prev) => ({
      ...prev,
      brandValues: prev.brandValues.map((val, i) =>
        i === index ? value : val
      ),
    }));
  };

  const removeBrandValue = (index: number) => {
    setBrandData((prev) => ({
      ...prev,
      brandValues: prev.brandValues.filter((_, i) => i !== index),
    }));
  };

  const handleSave = async () => {
    try {
      console.log("[BRAND DEBUG] Starting brand guidelines save...");
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
      Object.entries(brandData).forEach(([key, value]) => {
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

      const response = await axios.post(
        buildApiUrl("/api/brand/guidelines"),
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data",
          },
        }
      );

      console.log("[BRAND DEBUG] Save response:", response.data);

      // Clear file inputs
      setBrandAssets({
        logo: null,
        secondaryLogo: null,
        brandGuide: null,
      });

      // Reload data
      window.location.reload();

      toast({
        title: "Success",
        description: "Brand guidelines saved successfully!",
      });
    } catch (error) {
      console.error("[BRAND DEBUG] Error saving brand guidelines:", error);
      toast({
        title: "Error",
        description: "Failed to save brand guidelines. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setBrandData({
      brandName: "",
      tagline: "",
      primaryColor: "#7E69AB",
      primaryColorEnd: "#ECAC5F",
      secondaryColor: "#ECAC5F",
      fontFamily: "Inter",
      toneOfVoice: "",
      keyMessages: [],
      brandValues: [],
      targetAudience: "",
      brandPersonality: "",
      isGradient: true,
    });
    setBrandAssets({
      logo: null,
      secondaryLogo: null,
      brandGuide: null,
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"></div>
            <p className="mt-2 text-muted-foreground">
              Loading brand guidelines...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-extrabold text-gray-900 dark:text-[rgba(255,255,255,0.85)]">
              {brandData.brandName || "Your Brand"} Guidelines
            </h1>
            <div className="h-0.5 w-1/4 agent-gradient rounded-full"></div>
            <p className="text-gray-500 dark:text-[rgba(255,255,255,0.7)]">
              {brandData.tagline ||
                "Define your brand identity and guidelines for consistent communication"}
            </p>
          </div>
          <div className="flex gap-2">
            {isEditing && (
              <Button
                variant="outline"
                onClick={handleReset}
                className="flex items-center gap-2"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
            )}
            <Button
              onClick={() => {
                if (isEditing) {
                  handleSave();
                } else {
                  setIsEditing(true);
                }
              }}
              disabled={isSaving}
              className={`flex items-center gap-2 ${
                isEditing ? "use-template-button" : ""
              }`}
              variant={isEditing ? undefined : "outline"}
            >
              {isEditing ? (
                <>
                  <Save className="h-4 w-4" />
                  {isSaving ? "Saving..." : "Done"}
                </>
              ) : (
                <>
                  <Edit3 className="h-4 w-4" />
                  Customize
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Brand Identity */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Heart className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Brand Identity</CardTitle>
            </div>
            <CardDescription>
              Core brand information and identity
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="brandName">Brand Name</Label>
                  <Input
                    id="brandName"
                    value={brandData.brandName}
                    onChange={(e) =>
                      setBrandData((prev) => ({
                        ...prev,
                        brandName: e.target.value,
                      }))
                    }
                    placeholder="Your Company Name"
                  />
                </div>
                <div>
                  <Label htmlFor="tagline">Tagline</Label>
                  <Input
                    id="tagline"
                    value={brandData.tagline}
                    onChange={(e) =>
                      setBrandData((prev) => ({
                        ...prev,
                        tagline: e.target.value,
                      }))
                    }
                    placeholder="Your company's tagline or slogan"
                  />
                </div>
                <div>
                  <Label htmlFor="targetAudience">Target Audience</Label>
                  <Textarea
                    id="targetAudience"
                    value={brandData.targetAudience}
                    onChange={(e) =>
                      setBrandData((prev) => ({
                        ...prev,
                        targetAudience: e.target.value,
                      }))
                    }
                    placeholder="Describe your ideal customers and target market"
                    rows={3}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <p className="font-medium">Brand Name</p>
                  <p className="text-muted-foreground">
                    {brandData.brandName || "Not set"}
                  </p>
                </div>
                <div>
                  <p className="font-medium">Tagline</p>
                  <p className="text-muted-foreground">
                    {brandData.tagline || "Not set"}
                  </p>
                </div>
                <div>
                  <p className="font-medium">Target Audience</p>
                  <p className="text-muted-foreground">
                    {brandData.targetAudience || "Not set"}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Brand Colors */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Palette className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Brand Colors</CardTitle>
            </div>
            <CardDescription>
              Primary and secondary color palette
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                {/* Gradient Toggle */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="gradientToggle"
                    checked={brandData.isGradient}
                    onCheckedChange={(checked) =>
                      setBrandData((prev) => ({
                        ...prev,
                        isGradient: checked as boolean,
                      }))
                    }
                  />
                  <Label htmlFor="gradientToggle">
                    Use gradient for primary color
                  </Label>
                </div>

                {/* Color Pickers */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="primaryColor">
                      {brandData.isGradient ? "Primary Start" : "Primary Color"}
                    </Label>
                    <Input
                      id="primaryColor"
                      type="color"
                      value={brandData.primaryColor}
                      onChange={(e) =>
                        setBrandData((prev) => ({
                          ...prev,
                          primaryColor: e.target.value,
                        }))
                      }
                      className="h-10"
                    />
                  </div>
                  {brandData.isGradient && (
                    <div>
                      <Label htmlFor="primaryColorEnd">Primary End</Label>
                      <Input
                        id="primaryColorEnd"
                        type="color"
                        value={brandData.primaryColorEnd}
                        onChange={(e) =>
                          setBrandData((prev) => ({
                            ...prev,
                            primaryColorEnd: e.target.value,
                          }))
                        }
                        className="h-10"
                      />
                    </div>
                  )}
                  <div>
                    <Label htmlFor="secondaryColor">Secondary Color</Label>
                    <Input
                      id="secondaryColor"
                      type="color"
                      value={brandData.secondaryColor}
                      onChange={(e) =>
                        setBrandData((prev) => ({
                          ...prev,
                          secondaryColor: e.target.value,
                        }))
                      }
                      className="h-10"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-full"
                      style={{
                        background: brandData.isGradient
                          ? `linear-gradient(to right, ${brandData.primaryColor}, ${brandData.primaryColorEnd})`
                          : brandData.primaryColor,
                      }}
                    ></div>
                    <div>
                      <p className="font-medium">
                        Primary Color{brandData.isGradient ? " Gradient" : ""}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {brandData.isGradient
                          ? `${brandData.primaryColor} → ${brandData.primaryColorEnd}`
                          : brandData.primaryColor}
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary">Primary</Badge>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-full"
                      style={{ backgroundColor: brandData.secondaryColor }}
                    ></div>
                    <div>
                      <p className="font-medium">Secondary Color</p>
                      <p className="text-sm text-muted-foreground">
                        {brandData.secondaryColor}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline">Secondary</Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Typography */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Type className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Typography</CardTitle>
            </div>
            <CardDescription>
              Font family for consistent communication
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="fontFamily">Font Family</Label>
                  <Select
                    value={brandData.fontFamily}
                    onValueChange={(value) =>
                      setBrandData((prev) => ({ ...prev, fontFamily: value }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Inter">Inter</SelectItem>
                      <SelectItem value="Roboto">Roboto</SelectItem>
                      <SelectItem value="Open Sans">Open Sans</SelectItem>
                      <SelectItem value="Montserrat">Montserrat</SelectItem>
                      <SelectItem value="Poppins">Poppins</SelectItem>
                      <SelectItem value="Lato">Lato</SelectItem>
                      <SelectItem value="Arial">Arial</SelectItem>
                      <SelectItem value="Helvetica">Helvetica</SelectItem>
                      <SelectItem value="Georgia">Georgia</SelectItem>
                      <SelectItem value="Times New Roman">
                        Times New Roman
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Live Preview in Edit Mode */}
                <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-3 font-medium">
                    Live Preview:
                  </p>
                  <div className="space-y-3">
                    <div>
                      <h3
                        className="text-2xl font-bold"
                        style={{
                          fontFamily: `${getFontStack(
                            brandData.fontFamily
                          )} !important`,
                        }}
                      >
                        {brandData.brandName || "Your Brand Name"}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {brandData.fontFamily} - Bold
                      </p>
                    </div>
                    <div>
                      <p
                        className="text-base"
                        style={{
                          fontFamily: `${getFontStack(
                            brandData.fontFamily
                          )} !important`,
                        }}
                      >
                        {brandData.tagline || "Your company tagline goes here"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {brandData.fontFamily} - Regular
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <h3
                    className="text-2xl font-bold"
                    style={{
                      fontFamily: `${getFontStack(
                        brandData.fontFamily
                      )} !important`,
                    }}
                  >
                    {brandData.brandName || "Your Brand Name"}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {brandData.fontFamily} - Bold
                  </p>
                </div>
                <div>
                  <p
                    className="text-base"
                    style={{
                      fontFamily: `${getFontStack(
                        brandData.fontFamily
                      )} !important`,
                    }}
                  >
                    {brandData.tagline || "Your company tagline"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {brandData.fontFamily} - Regular
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Brand Voice & Messaging */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Brand Voice & Messaging</CardTitle>
            </div>
            <CardDescription>
              Tone of voice and brand personality
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="toneOfVoice">Tone of Voice</Label>
                  <Input
                    id="toneOfVoice"
                    value={brandData.toneOfVoice}
                    onChange={(e) =>
                      setBrandData((prev) => ({
                        ...prev,
                        toneOfVoice: e.target.value,
                      }))
                    }
                    placeholder="e.g., Professional yet friendly, Conversational, Authoritative"
                  />
                </div>
                <div>
                  <Label htmlFor="brandPersonality">Brand Personality</Label>
                  <Textarea
                    id="brandPersonality"
                    value={brandData.brandPersonality}
                    onChange={(e) =>
                      setBrandData((prev) => ({
                        ...prev,
                        brandPersonality: e.target.value,
                      }))
                    }
                    placeholder="Describe your brand's personality traits and characteristics"
                    rows={3}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <p className="font-medium">Tone of Voice</p>
                  <p className="text-muted-foreground">
                    {brandData.toneOfVoice || "Not set"}
                  </p>
                </div>
                <div>
                  <p className="font-medium">Brand Personality</p>
                  <p className="text-muted-foreground">
                    {brandData.brandPersonality || "Not set"}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Key Messages */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Key Messages</CardTitle>
            </div>
            <CardDescription>
              Important messages and value propositions
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                {brandData.keyMessages.map((message, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      value={message}
                      onChange={(e) => updateKeyMessage(index, e.target.value)}
                      placeholder="Enter a key message"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => removeKeyMessage(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" onClick={addKeyMessage}>
                  Add Message
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {brandData.keyMessages.length > 0 ? (
                  brandData.keyMessages.map((message, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5">
                        {index + 1}
                      </Badge>
                      <p className="text-sm">{message}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">No key messages set</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Brand Values */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Heart className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Brand Values</CardTitle>
            </div>
            <CardDescription>Core values that guide your brand</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                {brandData.brandValues.map((value, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      value={value}
                      onChange={(e) => updateBrandValue(index, e.target.value)}
                      placeholder="Enter a brand value"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => removeBrandValue(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" onClick={addBrandValue}>
                  Add Value
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {brandData.brandValues.length > 0 ? (
                  brandData.brandValues.map((value, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Badge variant="secondary">{value}</Badge>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">No brand values set</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Logo & Assets Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Logo Usage */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Image className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Logo & Assets</CardTitle>
            </div>
            <CardDescription>
              Upload your brand logos and visual assets
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="logoUpload">Primary Logo</Label>
                  <Input
                    id="logoUpload"
                    type="file"
                    accept="image/*"
                    onChange={(e) =>
                      handleFileChange("logo", e.target.files?.[0] || null)
                    }
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="secondaryLogoUpload">
                    Secondary Logo (Optional)
                  </Label>
                  <Input
                    id="secondaryLogoUpload"
                    type="file"
                    accept="image/*"
                    onChange={(e) =>
                      handleFileChange(
                        "secondaryLogo",
                        e.target.files?.[0] || null
                      )
                    }
                    className="mt-1"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {existingAssets.filter(
                  (asset) =>
                    asset.type === "logo" || asset.type === "secondaryLogo"
                ).length > 0 ? (
                  existingAssets
                    .filter(
                      (asset) =>
                        asset.type === "logo" || asset.type === "secondaryLogo"
                    )
                    .map((asset) => (
                      <div
                        key={asset.key}
                        className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          <img
                            src={asset.url}
                            alt={asset.filename}
                            className="h-12 w-12 object-contain bg-white rounded"
                          />
                          <div>
                            <p className="font-medium">
                              {asset.type === "logo"
                                ? "Primary Logo"
                                : "Secondary Logo"}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {asset.filename}
                            </p>
                          </div>
                        </div>
                        {isEditing && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => deleteAsset(asset.key)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))
                ) : (
                  <p className="text-muted-foreground">No logos uploaded</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Brand Guide Document */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Brand Guide Document</CardTitle>
            </div>
            <CardDescription>
              Upload your complete brand guidelines document
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="brandGuideUpload">Brand Guide (PDF)</Label>
                  <Input
                    id="brandGuideUpload"
                    type="file"
                    accept=".pdf,.doc,.docx"
                    onChange={(e) =>
                      handleFileChange(
                        "brandGuide",
                        e.target.files?.[0] || null
                      )
                    }
                    className="mt-1"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {existingAssets.filter((asset) => asset.type === "brandGuide")
                  .length > 0 ? (
                  existingAssets
                    .filter((asset) => asset.type === "brandGuide")
                    .map((asset) => (
                      <div
                        key={asset.key}
                        className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          <FileText className="h-8 w-8 text-[#7E69AB]" />
                          <div>
                            <p className="font-medium">Brand Guide</p>
                            <p className="text-sm text-muted-foreground">
                              {asset.filename}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open(asset.url, "_blank")}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          {isEditing && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => deleteAsset(asset.key)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))
                ) : (
                  <p className="text-muted-foreground">
                    No brand guide uploaded
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default BrandGuidelines;
