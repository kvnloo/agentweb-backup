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
  Target,
  Users,
  Building2,
  Edit3,
  Save,
  RotateCcw,
  Plus,
  Trash2,
  X,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Define types for market strategy data
interface Competitor {
  id: string;
  name: string;
  description: string;
}

interface ICP {
  id: string;
  title: string;
  description: string;
  valueProposition: string;
}

interface MarketStrategyData {
  businessOverview: string;
  competitors: Competitor[];
  icp: ICP[];
}

const MarketStrategy = () => {
  const { toast } = useToast();
  const { token } = useAuth();

  // State for editing mode
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Market strategy data state
  const [marketStrategyData, setMarketStrategyData] = useState<MarketStrategyData>({
    businessOverview: "",
    competitors: [],
    icp: [],
  });

  // Editing states for competitors and ICP
  const [editingCompetitor, setEditingCompetitor] = useState<string | null>(null);
  const [editingICP, setEditingICP] = useState<string | null>(null);

  // New item states
  const [newCompetitor, setNewCompetitor] = useState<Omit<Competitor, 'id'>>({
    name: "",
    description: "",
  });

  const [newICP, setNewICP] = useState<Omit<ICP, 'id'>>({
    title: "",
    description: "",
    valueProposition: "",
  });

  // Load market strategy data
  const loadMarketStrategy = async () => {
    try {
      setIsLoading(true);
      const response = await axios.get(buildApiUrl("/api/market-strategy"), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.data.success) {
        setMarketStrategyData(response.data.data);
      }
    } catch (error) {
      console.error("Error loading market strategy:", error);
      toast({
        title: "Error",
        description: "Failed to load market strategy data",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Save market strategy data
  const handleSave = async () => {
    try {
      setIsSaving(true);
      const response = await axios.post(
        buildApiUrl("/api/market-strategy"),
        marketStrategyData,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        toast({
          title: "Success",
          description: "Market strategy saved successfully",
        });
        setIsEditing(false);
      }
    } catch (error) {
      console.error("Error saving market strategy:", error);
      toast({
        title: "Error",
        description: "Failed to save market strategy",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Reset to original data
  const handleReset = async () => {
    await loadMarketStrategy();
    setIsEditing(false);
    setEditingCompetitor(null);
    setEditingICP(null);
    setNewCompetitor({
      name: "",
      description: "",
    });
    setNewICP({
      title: "",
      description: "",
      valueProposition: "",
    });
  };

  // Competitor management functions
  const addCompetitor = () => {
    if (!newCompetitor.name.trim()) {
      toast({
        title: "Error",
        description: "Competitor name is required",
        variant: "destructive",
      });
      return;
    }

    const competitor: Competitor = {
      id: Date.now().toString(),
      ...newCompetitor,
    };

    setMarketStrategyData(prev => ({
      ...prev,
      competitors: [...prev.competitors, competitor],
    }));

    setNewCompetitor({
      name: "",
      description: "",
    });
  };

  const updateCompetitor = (id: string, field: keyof Competitor, value: string) => {
    setMarketStrategyData(prev => ({
      ...prev,
      competitors: prev.competitors.map(comp =>
        comp.id === id ? { ...comp, [field]: value } : comp
      ),
    }));
  };

  const deleteCompetitor = (id: string) => {
    setMarketStrategyData(prev => ({
      ...prev,
      competitors: prev.competitors.filter(comp => comp.id !== id),
    }));
  };

  const startEditingCompetitor = (id: string) => {
    setEditingCompetitor(id);
  };

  const saveEditingCompetitor = (id: string) => {
    setEditingCompetitor(null);
  };

  // ICP management functions
  const addICP = () => {
    if (!newICP.title.trim()) {
      toast({
        title: "Error",
        description: "ICP title is required",
        variant: "destructive",
      });
      return;
    }

    const icp: ICP = {
      id: Date.now().toString(),
      ...newICP,
    };

    setMarketStrategyData(prev => ({
      ...prev,
      icp: [...prev.icp, icp],
    }));

    setNewICP({
      title: "",
      description: "",
      valueProposition: "",
    });
  };

  const updateICP = (id: string, field: keyof ICP, value: string) => {
    setMarketStrategyData(prev => ({
      ...prev,
      icp: prev.icp.map(icp =>
        icp.id === id ? { ...icp, [field]: value } : icp
      ),
    }));
  };

  const deleteICP = (id: string) => {
    setMarketStrategyData(prev => ({
      ...prev,
      icp: prev.icp.filter(icp => icp.id !== id),
    }));
  };

  const startEditingICP = (id: string) => {
    setEditingICP(id);
  };

  const saveEditingICP = (id: string) => {
    setEditingICP(null);
  };

  // Load data on component mount
  useEffect(() => {
    if (token) {
      loadMarketStrategy();
    }
  }, [token]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#7E69AB] mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading market strategy...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Market Strategy
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Define your business overview, analyze competitors, and identify your ideal customer profile
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={isSaving}
                className="flex items-center gap-2"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
              <Button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-2 bg-[#7E69AB] hover:bg-[#6B5A9A]"
              >
                {isSaving ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {isSaving ? "Saving..." : "Save Changes"}
              </Button>
            </>
          ) : (
            <Button
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-2 bg-[#7E69AB] hover:bg-[#6B5A9A]"
            >
              <Edit3 className="h-4 w-4" />
              Edit Strategy
            </Button>
          )}
        </div>
      </div>

      {/* Business Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[#7E69AB]" />
            Business Overview
          </CardTitle>
          <CardDescription>
            Provide an overview of your business, including your mission, vision, and key value propositions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <Label htmlFor="business-overview" className="text-sm font-medium">
                Business Overview
              </Label>
              <Textarea
                id="business-overview"
                placeholder="Describe your business, mission, vision, and key value propositions..."
                value={marketStrategyData.businessOverview}
                onChange={(e) =>
                  setMarketStrategyData(prev => ({
                    ...prev,
                    businessOverview: e.target.value,
                  }))
                }
                disabled={!isEditing}
                className="mt-2 min-h-[120px] resize-none"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Competitors */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-[#7E69AB]" />
            Competitors
          </CardTitle>
          <CardDescription>
            Analyze your main competitors and understand their strengths and weaknesses
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* Existing Competitors */}
            {marketStrategyData.competitors.map((competitor) => (
              <div
                key={competitor.id}
                className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-gray-900 dark:text-white">
                    {editingCompetitor === competitor.id ? (
                      <Input
                        value={competitor.name}
                        onChange={(e) => updateCompetitor(competitor.id, 'name', e.target.value)}
                        className="max-w-xs"
                      />
                    ) : (
                      competitor.name
                    )}
                  </h4>
                  {isEditing && (
                    <div className="flex items-center gap-2">
                      {editingCompetitor === competitor.id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => saveEditingCompetitor(competitor.id)}
                          className="h-8 w-8 p-0"
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startEditingCompetitor(competitor.id)}
                          className="h-8 w-8 p-0"
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteCompetitor(competitor.id)}
                        className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <Label className="text-sm font-medium">Description</Label>
                    {editingCompetitor === competitor.id ? (
                      <Textarea
                        value={competitor.description}
                        onChange={(e) => updateCompetitor(competitor.id, 'description', e.target.value)}
                        className="mt-1 min-h-[80px]"
                      />
                    ) : (
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        {competitor.description || "No description provided"}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* Add New Competitor */}
            {isEditing && (
              <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 space-y-4">
                <h4 className="font-semibold text-gray-900 dark:text-white">Add New Competitor</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium">Name *</Label>
                    <Input
                      value={newCompetitor.name}
                      onChange={(e) => setNewCompetitor(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="Competitor name"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Description</Label>
                    <Textarea
                      value={newCompetitor.description}
                      onChange={(e) => setNewCompetitor(prev => ({ ...prev, description: e.target.value }))}
                      placeholder="Brief description of the competitor"
                      className="mt-1 min-h-[80px]"
                    />
                  </div>
                </div>
                <Button
                  onClick={addCompetitor}
                  className="flex items-center gap-2 bg-[#7E69AB] hover:bg-[#6B5A9A]"
                >
                  <Plus className="h-4 w-4" />
                  Add Competitor
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Ideal Customer Profile (ICP) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-[#7E69AB]" />
            Ideal Customer Profile (ICP)
          </CardTitle>
          <CardDescription>
            Define your ideal customer profiles to better target your marketing and sales efforts
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* Existing ICPs */}
            {marketStrategyData.icp.map((icp) => (
              <div
                key={icp.id}
                className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-gray-900 dark:text-white">
                    {editingICP === icp.id ? (
                      <Input
                        value={icp.title}
                        onChange={(e) => updateICP(icp.id, 'title', e.target.value)}
                        className="max-w-xs"
                      />
                    ) : (
                      icp.title
                    )}
                  </h4>
                  {isEditing && (
                    <div className="flex items-center gap-2">
                      {editingICP === icp.id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => saveEditingICP(icp.id)}
                          className="h-8 w-8 p-0"
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startEditingICP(icp.id)}
                          className="h-8 w-8 p-0"
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteICP(icp.id)}
                        className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium">Description</Label>
                    {editingICP === icp.id ? (
                      <Textarea
                        value={icp.description}
                        onChange={(e) => updateICP(icp.id, 'description', e.target.value)}
                        className="mt-1 min-h-[80px]"
                      />
                    ) : (
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        {icp.description || "No description provided"}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Value Proposition</Label>
                    {editingICP === icp.id ? (
                      <Textarea
                        value={icp.valueProposition}
                        onChange={(e) => updateICP(icp.id, 'valueProposition', e.target.value)}
                        className="mt-1 min-h-[80px]"
                      />
                    ) : (
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        {icp.valueProposition || "No value proposition listed"}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* Add New ICP */}
            {isEditing && (
              <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 space-y-4">
                <h4 className="font-semibold text-gray-900 dark:text-white">Add New ICP</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium">Title *</Label>
                    <Input
                      value={newICP.title}
                      onChange={(e) => setNewICP(prev => ({ ...prev, title: e.target.value }))}
                      placeholder="ICP title (e.g., Small Business Owner)"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Description</Label>
                    <Textarea
                      value={newICP.description}
                      onChange={(e) => setNewICP(prev => ({ ...prev, description: e.target.value }))}
                      placeholder="Brief description of this customer profile"
                      className="mt-1 min-h-[80px]"
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Value Proposition</Label>
                    <Textarea
                      value={newICP.valueProposition}
                      onChange={(e) => setNewICP(prev => ({ ...prev, valueProposition: e.target.value }))}
                      placeholder="Value proposition for this customer type"
                      className="mt-1 min-h-[80px]"
                    />
                  </div>
                </div>
                <Button
                  onClick={addICP}
                  className="flex items-center gap-2 bg-[#7E69AB] hover:bg-[#6B5A9A]"
                >
                  <Plus className="h-4 w-4" />
                  Add ICP
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default MarketStrategy; 