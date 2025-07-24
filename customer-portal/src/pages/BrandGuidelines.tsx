import { useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Define types for brand customization
interface BrandColors {
  primaryStart: string;
  primaryEnd: string;
  purple: string;
  gold: string;
  isGradient: boolean;
  primaryName: string;
  secondaryName: string;
  accentName: string;
}

interface Typography {
  fontFamily: string;
  headingSize: string;
  bodySize: string;
}

interface LogoSettings {
  logoUrl: string;
  minWidth: string;
  clearSpace: string;
}

const BrandGuidelines = () => {
  // State for customization mode
  const [isEditing, setIsEditing] = useState(false);

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
    };
    return fontStacks[fontFamily as keyof typeof fontStacks] || fontFamily;
  };

  // Default brand values
  const defaultColors: BrandColors = {
    primaryStart: "#7E69AB",
    primaryEnd: "#ECAC5F",
    purple: "#7E69AB",
    gold: "#ECAC5F",
    isGradient: true,
    primaryName: "Primary",
    secondaryName: "Secondary",
    accentName: "Accent",
  };

  const defaultTypography: Typography = {
    fontFamily: "Inter",
    headingSize: "24px",
    bodySize: "16px",
  };

  const defaultLogo: LogoSettings = {
    logoUrl: "/src/assets/AgentWeb-Logo-189x62.svg",
    minWidth: "120px",
    clearSpace: "1x logo height",
  };

  // State for current values
  const [colors, setColors] = useState<BrandColors>(defaultColors);
  const [typography, setTypography] = useState<Typography>(defaultTypography);
  const [logo, setLogo] = useState<LogoSettings>(defaultLogo);

  const handleReset = () => {
    setColors(defaultColors);
    setTypography(defaultTypography);
    setLogo(defaultLogo);
  };

  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setLogo({ ...logo, logoUrl: url });
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-extrabold text-gray-900 dark:text-[rgba(255,255,255,0.85)]">
              Brand Guidelines
            </h1>
            <div className="h-0.5 w-1/4 agent-gradient rounded-full"></div>
            <p className="text-gray-500 dark:text-[rgba(255,255,255,0.7)]">
              Essential brand assets, guidelines, and resources for maintaining
              brand consistency across all touchpoints.
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
              onClick={() => setIsEditing(!isEditing)}
              className={`flex items-center gap-2 ${
                isEditing ? "use-template-button" : ""
              }`}
              variant={isEditing ? undefined : "outline"}
            >
              {isEditing ? (
                <>
                  <Save className="h-4 w-4" />
                  Done
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
        {/* Brand Colors */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Palette className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Brand Colors</CardTitle>
            </div>
            <CardDescription>
              Primary and secondary color palette for AgentWeb brand
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div className="space-y-4">
                  {/* Color Names */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <Label htmlFor="primaryName">Primary Name</Label>
                      <Input
                        id="primaryName"
                        value={colors.primaryName}
                        onChange={(e) =>
                          setColors({ ...colors, primaryName: e.target.value })
                        }
                        placeholder="Primary"
                      />
                    </div>
                    <div>
                      <Label htmlFor="secondaryName">Secondary Name</Label>
                      <Input
                        id="secondaryName"
                        value={colors.secondaryName}
                        onChange={(e) =>
                          setColors({
                            ...colors,
                            secondaryName: e.target.value,
                          })
                        }
                        placeholder="Secondary"
                      />
                    </div>
                    <div>
                      <Label htmlFor="accentName">Accent Name</Label>
                      <Input
                        id="accentName"
                        value={colors.accentName}
                        onChange={(e) =>
                          setColors({ ...colors, accentName: e.target.value })
                        }
                        placeholder="Accent"
                      />
                    </div>
                  </div>

                  {/* Primary Color Toggle */}
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="gradientToggle"
                      checked={colors.isGradient}
                      onCheckedChange={(checked) =>
                        setColors({ ...colors, isGradient: checked as boolean })
                      }
                    />
                    <Label htmlFor="gradientToggle">
                      Use gradient for primary color
                    </Label>
                  </div>

                  {/* Color Pickers */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="primaryStart">
                        {colors.isGradient ? "Primary Start" : "Primary Color"}
                      </Label>
                      <Input
                        id="primaryStart"
                        type="color"
                        value={colors.primaryStart}
                        onChange={(e) =>
                          setColors({ ...colors, primaryStart: e.target.value })
                        }
                        className="h-10"
                      />
                    </div>
                    {colors.isGradient && (
                      <div>
                        <Label htmlFor="primaryEnd">Primary End</Label>
                        <Input
                          id="primaryEnd"
                          type="color"
                          value={colors.primaryEnd}
                          onChange={(e) =>
                            setColors({ ...colors, primaryEnd: e.target.value })
                          }
                          className="h-10"
                        />
                      </div>
                    )}
                    <div>
                      <Label htmlFor="purple">{colors.secondaryName}</Label>
                      <Input
                        id="purple"
                        type="color"
                        value={colors.purple}
                        onChange={(e) =>
                          setColors({ ...colors, purple: e.target.value })
                        }
                        className="h-10"
                      />
                    </div>
                    <div>
                      <Label htmlFor="gold">{colors.accentName}</Label>
                      <Input
                        id="gold"
                        type="color"
                        value={colors.gold}
                        onChange={(e) =>
                          setColors({ ...colors, gold: e.target.value })
                        }
                        className="h-10"
                      />
                    </div>
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
                        background: colors.isGradient
                          ? `linear-gradient(to right, ${colors.primaryStart}, ${colors.primaryEnd})`
                          : colors.primaryStart,
                      }}
                    ></div>
                    <div>
                      <p className="font-medium">
                        {colors.primaryName}{" "}
                        {colors.isGradient ? "Gradient" : ""}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {colors.isGradient
                          ? `${colors.primaryStart} → ${colors.primaryEnd}`
                          : colors.primaryStart}
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary">Primary</Badge>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-full"
                      style={{ backgroundColor: colors.purple }}
                    ></div>
                    <div>
                      <p className="font-medium">{colors.secondaryName}</p>
                      <p className="text-sm text-muted-foreground">
                        {colors.purple}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline">Secondary</Badge>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-full"
                      style={{ backgroundColor: colors.gold }}
                    ></div>
                    <div>
                      <p className="font-medium">{colors.accentName}</p>
                      <p className="text-sm text-muted-foreground">
                        {colors.gold}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline">Accent</Badge>
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
              Font families and text styles for consistent communication
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="fontFamily">Font Family</Label>
                  <Select
                    value={typography.fontFamily}
                    onValueChange={(value) =>
                      setTypography({ ...typography, fontFamily: value })
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
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="headingSize">Heading Size</Label>
                    <Input
                      id="headingSize"
                      value={typography.headingSize}
                      onChange={(e) =>
                        setTypography({
                          ...typography,
                          headingSize: e.target.value,
                        })
                      }
                      placeholder="24px"
                    />
                  </div>
                  <div>
                    <Label htmlFor="bodySize">Body Size</Label>
                    <Input
                      id="bodySize"
                      value={typography.bodySize}
                      onChange={(e) =>
                        setTypography({
                          ...typography,
                          bodySize: e.target.value,
                        })
                      }
                      placeholder="16px"
                    />
                  </div>
                </div>

                {/* Live Preview in Edit Mode */}
                <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-3 font-medium">
                    Live Preview:
                  </p>
                  <div className="space-y-3">
                    <div>
                      <h3
                        className="font-bold"
                        style={{
                          fontFamily: `${getFontStack(
                            typography.fontFamily
                          )} !important`,
                          fontSize: `${typography.headingSize} !important`,
                          lineHeight: "1.2",
                        }}
                      >
                        Heading Example
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {typography.fontFamily} - Bold, {typography.headingSize}
                      </p>
                    </div>
                    <div>
                      <h4
                        className="font-semibold"
                        style={{
                          fontFamily: `${getFontStack(
                            typography.fontFamily
                          )} !important`,
                          fontSize: `calc(${typography.headingSize} * 0.75) !important`,
                          lineHeight: "1.3",
                        }}
                      >
                        Subheading Example
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        {typography.fontFamily} - Semibold, ~18px
                      </p>
                    </div>
                    <div>
                      <p
                        style={{
                          fontFamily: `${getFontStack(
                            typography.fontFamily
                          )} !important`,
                          fontSize: `${typography.bodySize} !important`,
                          lineHeight: "1.5",
                        }}
                      >
                        Body text example for readability and clarity.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {typography.fontFamily} - Regular, {typography.bodySize}
                      </p>
                    </div>
                    <div>
                      <p
                        className="text-muted-foreground"
                        style={{
                          fontFamily: `${getFontStack(
                            typography.fontFamily
                          )} !important`,
                          fontSize: `calc(${typography.bodySize} * 0.875) !important`,
                          lineHeight: "1.4",
                        }}
                      >
                        Small text for captions and metadata.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {typography.fontFamily} - Regular, ~14px
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
                        typography.fontFamily
                      )} !important`,
                      fontSize: `${typography.headingSize} !important`,
                      lineHeight: "1.2",
                    }}
                  >
                    Heading Example
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {typography.fontFamily} - Bold, {typography.headingSize}
                  </p>
                </div>
                <div>
                  <h4
                    className="text-lg font-semibold"
                    style={{
                      fontFamily: `${getFontStack(
                        typography.fontFamily
                      )} !important`,
                      fontSize: `calc(${typography.headingSize} * 0.75) !important`,
                      lineHeight: "1.3",
                    }}
                  >
                    Subheading Example
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {typography.fontFamily} - Semibold, ~18px
                  </p>
                </div>
                <div>
                  <p
                    className="text-base"
                    style={{
                      fontFamily: `${getFontStack(
                        typography.fontFamily
                      )} !important`,
                      fontSize: `${typography.bodySize} !important`,
                      lineHeight: "1.5",
                    }}
                  >
                    Body text example for readability and clarity.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {typography.fontFamily} - Regular, {typography.bodySize}
                  </p>
                </div>
                <div>
                  <p
                    className="text-sm text-muted-foreground"
                    style={{
                      fontFamily: `${getFontStack(
                        typography.fontFamily
                      )} !important`,
                      fontSize: `calc(${typography.bodySize} * 0.875) !important`,
                      lineHeight: "1.4",
                    }}
                  >
                    Small text for captions and metadata.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {typography.fontFamily} - Regular, ~14px
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Logo Usage */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Image className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>Logo Usage</CardTitle>
            </div>
            <CardDescription>
              Guidelines for proper logo placement and usage
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="logoUpload">Upload Logo</Label>
                  <Input
                    id="logoUpload"
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="mt-1"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="minWidth">Minimum Width</Label>
                    <Input
                      id="minWidth"
                      value={logo.minWidth}
                      onChange={(e) =>
                        setLogo({ ...logo, minWidth: e.target.value })
                      }
                      placeholder="120px"
                    />
                  </div>
                  <div>
                    <Label htmlFor="clearSpace">Clear Space</Label>
                    <Input
                      id="clearSpace"
                      value={logo.clearSpace}
                      onChange={(e) =>
                        setLogo({ ...logo, clearSpace: e.target.value })
                      }
                      placeholder="1x logo height"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg flex items-center justify-center">
                  <img
                    src={logo.logoUrl}
                    alt="AgentWeb Logo"
                    className="h-8"
                    style={{ minWidth: logo.minWidth }}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Usage Guidelines:</p>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    <li>
                      • Maintain clear space around logo (minimum{" "}
                      {logo.clearSpace})
                    </li>
                    <li>• Don't alter colors or proportions</li>
                    <li>• Use on appropriate background contrast</li>
                    <li>
                      • Minimum size: {logo.minWidth} width for digital use
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Coming Soon Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Download Brand Assets</CardTitle>
              <CardDescription>
                Access logos, icons, and other brand materials
              </CardDescription>
            </div>
            <Download className="h-5 w-5 text-[#7E69AB]" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">
              Brand asset downloads will be available soon. Contact support for
              immediate access to brand materials.
            </p>
            <Button variant="outline" disabled>
              Coming Soon
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default BrandGuidelines;
