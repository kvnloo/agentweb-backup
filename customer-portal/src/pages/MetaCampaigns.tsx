import { useState, useEffect } from "react";
import axios from "axios";
import { buildApiUrl } from "@/config";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUp,
  Eye,
  MousePointer,
  DollarSign,
  Users,
  Calendar,
  AlertCircle,
  ExternalLink,
  BarChart3,
  Target,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

// Define types for Meta ad performance data
interface AdPerformance {
  id: string;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  spend: number;
  ctr: number;
  cpc: number;
  reach: number;
  frequency: number;
  lastUpdated: string;
}

interface CampaignSummary {
  totalCampaigns: number;
  activeCampaigns: number;
  totalSpend: number;
  totalImpressions: number;
  totalClicks: number;
  averageCtr: number;
  averageCpc: number;
}

const MetaCampaigns = () => {
  const { toast } = useToast();
  const { token } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [hasAdAccount, setHasAdAccount] = useState(false);
  const [adPerformance, setAdPerformance] = useState<AdPerformance[]>([]);
  const [campaignSummary, setCampaignSummary] = useState<CampaignSummary | null>(null);
  const [selectedTimeframe, setSelectedTimeframe] = useState("7d");

  useEffect(() => {
    checkAdAccountStatus();
  }, []);

  const checkAdAccountStatus = async () => {
    if (!token) {
      console.error("No authentication token available");
      setHasAdAccount(false);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const response = await axios.get(`${buildApiUrl('/api/meta/account-status')}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setHasAdAccount(response.data.hasAdAccount);
      
      if (response.data.hasAdAccount) {
        fetchAdPerformance();
      }
    } catch (error: any) {
      console.error("Error checking ad account status:", error);
      
      // Display detailed error information
      const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message || "Unknown error";
      const errorDetails = error.response?.data?.details;
      
      toast({
        title: "Meta API Error",
        description: (
          <div>
            <p><strong>Error:</strong> {errorMessage}</p>
            {errorDetails && <p><strong>Details:</strong> {errorDetails}</p>}
          </div>
        ),
        variant: "destructive",
      });
      
      setHasAdAccount(false);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAdPerformance = async () => {
    if (!token) {
      console.error("No authentication token available");
      return;
    }

    try {
      const response = await axios.get(`${buildApiUrl('/api/meta/ad-performance')}`, {
        params: { timeframe: selectedTimeframe },
        headers: { Authorization: `Bearer ${token}` }
      });
      setAdPerformance(response.data.adPerformance);
      setCampaignSummary(response.data.campaignSummary);
    } catch (error: any) {
      console.error("Error fetching ad performance", error);
      
      // Display detailed error information
      const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message || "Unknown error";
      const errorDetails = error.response?.data?.details;
      
      toast({
        title: "Meta API Error",
        description: (
          <div>
            <p><strong>Error:</strong> {errorMessage}</p>
            {errorDetails && <p><strong>Details:</strong> {errorDetails}</p>}
          </div>
        ),
        variant: "destructive",
      });
    }
  };

  const handleTimeframeChange = (timeframe: string) => {
    setSelectedTimeframe(timeframe);
    if (hasAdAccount) {
      fetchAdPerformance();
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  const formatPercentage = (num: number) => {
    return `${(num * 100).toFixed(2)}%`;
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex items-center space-x-2">
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-16" />
              </CardHeader>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-12 w-12 rounded-full" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!hasAdAccount) {
    return (
      <div className="container mx-auto p-6">
        <div className="max-w-2xl mx-auto text-center space-y-6">
          <div className="flex justify-center">
            <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center">
              <Target className="w-10 h-10 text-blue-600" />
            </div>
          </div>
          
          <div className="space-y-4">
            <h1 className="text-3xl font-bold text-gray-900">
              Meta Campaigns
            </h1>
            <p className="text-lg text-gray-600">
              Track your Facebook and Instagram ad performance in real-time
            </p>
          </div>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Ad Account Not Configured</strong>
              <br />
              To access Meta Campaigns, your ad account needs to be configured by an administrator. 
              Please contact your admin to set up your Meta ad account in the partner portal.
            </AlertDescription>
          </Alert>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button variant="outline" onClick={() => window.history.back()}>
              Go Back
            </Button>
            <Button 
              onClick={() => {
                // You can add a contact form or redirect to a contact page
                toast({
                  title: "Contact Admin",
                  description: "Please contact your administrator to configure your Meta ad account.",
                });
              }}
            >
              Contact Admin
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Meta Campaigns</h1>
          <p className="text-gray-600 mt-2">
            Monitor and analyze your Facebook and Instagram ad performance
          </p>
        </div>
        
        <div className="flex items-center space-x-2">
          <Button
            variant={selectedTimeframe === "7d" ? "default" : "outline"}
            size="sm"
            onClick={() => handleTimeframeChange("7d")}
          >
            7 Days
          </Button>
          <Button
            variant={selectedTimeframe === "30d" ? "default" : "outline"}
            size="sm"
            onClick={() => handleTimeframeChange("30d")}
          >
            30 Days
          </Button>
          <Button
            variant={selectedTimeframe === "90d" ? "default" : "outline"}
            size="sm"
            onClick={() => handleTimeframeChange("90d")}
          >
            90 Days
          </Button>
        </div>
      </div>

      {/* Campaign Summary Cards */}
      {campaignSummary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Campaigns</CardTitle>
              <Target className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{campaignSummary.totalCampaigns}</div>
              <p className="text-xs text-muted-foreground">
                {campaignSummary.activeCampaigns} active
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Spend</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(campaignSummary.totalSpend)}
              </div>
              <p className="text-xs text-muted-foreground">
                Last {selectedTimeframe}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Impressions</CardTitle>
              <Eye className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatNumber(campaignSummary.totalImpressions)}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatNumber(campaignSummary.totalClicks)} clicks
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg. CTR</CardTitle>
              <MousePointer className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatPercentage(campaignSummary.averageCtr)}
              </div>
              <p className="text-xs text-muted-foreground">
                Avg. CPC: {formatCurrency(campaignSummary.averageCpc)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Ad Performance Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <BarChart3 className="h-5 w-5" />
            <span>Ad Performance</span>
          </CardTitle>
          <CardDescription>
            Detailed performance metrics for your Meta ads
          </CardDescription>
        </CardHeader>
        <CardContent>
          {adPerformance.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Zap className="h-12 w-12 mx-auto mb-4 text-gray-300" />
              <p>No ad performance data available for the selected timeframe.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border border-gray-200 rounded-lg">
                <thead>
                  <tr className="border-b bg-gray-100">
                    <th className="text-left py-3 px-4 font-medium text-gray-700">Campaign</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-700">Status</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Impressions</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Clicks</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">CTR</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Spend</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">CPC</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Reach</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-700">Frequency</th>
                  </tr>
                </thead>
                <tbody>
                  {adPerformance.map((ad) => (
                    <tr key={ad.id} className="border-b hover:bg-blue-50 hover:text-gray-900 transition-colors duration-150">
                      <td className="py-3 px-4">
                        <div>
                          <div className="font-medium">{ad.name}</div>
                          <div className="text-sm text-gray-500">
                            Last updated: {new Date(ad.lastUpdated).toLocaleDateString()}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <Badge
                          variant={ad.status === "ACTIVE" ? "default" : "secondary"}
                        >
                          {ad.status}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {formatNumber(ad.impressions)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {formatNumber(ad.clicks)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {formatPercentage(ad.ctr)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {formatCurrency(ad.spend)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {formatCurrency(ad.cpc)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {formatNumber(ad.reach)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {ad.frequency.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex justify-center space-x-4">
        <Button variant="outline" onClick={() => window.open("https://business.facebook.com", "_blank")}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Open Meta Business Manager
        </Button>
        <Button onClick={fetchAdPerformance}>
          <TrendingUp className="h-4 w-4 mr-2" />
          Refresh Data
        </Button>
      </div>
    </div>
  );
};

export default MetaCampaigns;
