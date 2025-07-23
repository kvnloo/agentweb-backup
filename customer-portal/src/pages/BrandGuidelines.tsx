import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Palette, Type, Layout, Image, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

const BrandGuidelines = () => {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-4xl font-extrabold text-gray-900 dark:text-[rgba(255,255,255,0.85)]">
          Brand Guidelines
        </h1>
        <div className="h-0.5 w-1/4 agent-gradient rounded-full"></div>
        <p className="text-gray-500 dark:text-[rgba(255,255,255,0.7)]">
          Essential brand assets, guidelines, and resources for maintaining
          brand consistency across all touchpoints.
        </p>
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
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-r from-[#7E69AB] to-[#ECAC5F]"></div>
                  <div>
                    <p className="font-medium">Primary Gradient</p>
                    <p className="text-sm text-muted-foreground">
                      #7E69AB → #ECAC5F
                    </p>
                  </div>
                </div>
                <Badge variant="secondary">Primary</Badge>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#7E69AB]"></div>
                  <div>
                    <p className="font-medium">Purple</p>
                    <p className="text-sm text-muted-foreground">#7E69AB</p>
                  </div>
                </div>
                <Badge variant="outline">Secondary</Badge>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#ECAC5F]"></div>
                  <div>
                    <p className="font-medium">Gold</p>
                    <p className="text-sm text-muted-foreground">#ECAC5F</p>
                  </div>
                </div>
                <Badge variant="outline">Accent</Badge>
              </div>
            </div>
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
            <div className="space-y-3">
              <div>
                <h3 className="text-2xl font-bold">Heading Example</h3>
                <p className="text-sm text-muted-foreground">
                  Inter - Bold, 24px
                </p>
              </div>
              <div>
                <h4 className="text-lg font-semibold">Subheading Example</h4>
                <p className="text-sm text-muted-foreground">
                  Inter - Semibold, 18px
                </p>
              </div>
              <div>
                <p className="text-base">
                  Body text example for readability and clarity.
                </p>
                <p className="text-sm text-muted-foreground">
                  Inter - Regular, 16px
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  Small text for captions and metadata.
                </p>
                <p className="text-xs text-muted-foreground">
                  Inter - Regular, 14px
                </p>
              </div>
            </div>
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
            <div className="space-y-3">
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg flex items-center justify-center">
                <img
                  src="/src/assets/AgentWeb-Logo-189x62.svg"
                  alt="AgentWeb Logo"
                  className="h-8"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Usage Guidelines:</p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>
                    • Maintain clear space around logo (minimum 1x logo height)
                  </li>
                  <li>• Don't alter colors or proportions</li>
                  <li>• Use on appropriate background contrast</li>
                  <li>• Minimum size: 120px width for digital use</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* UI Components */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Layout className="h-5 w-5 text-[#7E69AB]" />
              <CardTitle>UI Components</CardTitle>
            </div>
            <CardDescription>
              Consistent component styles and patterns
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium mb-2">Button Styles:</p>
                <div className="flex gap-2 flex-wrap">
                  <Button className="agent-button">Primary Button</Button>
                  <Button variant="outline">Secondary Button</Button>
                  <Button variant="ghost">Ghost Button</Button>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium mb-2">Color Badges:</p>
                <div className="flex gap-2 flex-wrap">
                  <Badge>Default</Badge>
                  <Badge variant="secondary">Secondary</Badge>
                  <Badge variant="outline">Outline</Badge>
                  <Badge variant="destructive">Error</Badge>
                </div>
              </div>
            </div>
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
