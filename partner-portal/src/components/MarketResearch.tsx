import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { createMarketResearch, getMarketResearch, getAllMarketResearch } from '../services/marketingService';

interface MarketResearchParams {
  query: string;
  targetMarket: string;
  competitors: string[];
}

interface Task {
  taskId: string;
  status: string;
  execution?: {
    result?: string;
    status?: string;
  };
  createdAt: string;
  target?: string;
  industry?: string;
  competitors?: string[];
  audience?: string;
}

const MarketResearch = () => {
  const { token } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);
  const [target, setTarget] = useState('');
  const [industry, setIndustry] = useState('');
  const [competitors, setCompetitors] = useState('');
  const [audience, setAudience] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [view, setView] = useState('form');
  
  useEffect(() => {
    loadRecentTasks();
  }, [token]);
  
  const loadRecentTasks = async () => {
    if (!token) return;
    
    try {
      setIsLoading(true);
      setError(null);
      
      const tasks = await getAllMarketResearch(token);
      setRecentTasks(tasks);
    } catch (err) {
      setError('An error occurred while loading recent tasks');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };
  
  const loadTask = async (id: string) => {
    if (!token) return;
    
    try {
      setIsLoading(true);
      setError(null);
      
      const task = await getMarketResearch(id, token);
      
      if (task) {
        // Extract info from task name or prompt
        let taskInfo = {
          target: '',
          industry: '',
          competitors: '',
          audience: ''
        };
        
        if (task.prompt) {
          // Try to extract info from prompt
          const industryMatch = task.prompt.match(/Industry:\s*([^\n]+)/);
          const competitorsMatch = task.prompt.match(/Competitors:\s*([^\n]+)/);
          const audienceMatch = task.prompt.match(/Target audience:\s*([^\n]+)/);
          
          if (industryMatch) taskInfo.industry = industryMatch[1].trim();
          if (competitorsMatch) taskInfo.competitors = competitorsMatch[1].trim();
          if (audienceMatch) taskInfo.audience = audienceMatch[1].trim();
          
          // Target might be in the first line
          const targetMatch = task.prompt.match(/Perform market research on ([^.]+)/);
          if (targetMatch && targetMatch[1] !== 'the specified industry') {
            taskInfo.target = targetMatch[1].trim();
          }
        }
        
        // Also try to extract target from task name
        if (task.name && task.name.includes('Market Research for ')) {
          const nameMatch = task.name.match(/Market Research for (.+)/);
          if (nameMatch) taskInfo.target = nameMatch[1].trim();
        }
        
        setTarget(taskInfo.target);
        setIndustry(taskInfo.industry);
        setCompetitors(taskInfo.competitors);
        setAudience(taskInfo.audience);
        setTaskId(id);
        setView('result');
      } else {
        setError('Failed to load task details');
      }
    } catch (err) {
      setError('An error occurred while loading task details');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!token) {
      setError('You must be logged in to submit a request');
      return;
    }
    
    try {
      setIsLoading(true);
      setError(null);
      
      const competitorsList = competitors
        .split(',')
        .map(c => c.trim())
        .filter(c => c.length > 0);
      
      const params: MarketResearchParams = {
        query: target,
        targetMarket: industry,
        competitors: competitorsList
      };
      
      const response = await createMarketResearch(params, token);
      
      if (response && response.task && response.task.taskId) {
        setTaskId(response.task.taskId);
        setView('result');
        await loadRecentTasks();
      } else {
        setError('Failed to create market research task');
      }
    } catch (err) {
      setError('An error occurred while submitting the request');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };
  
  const resetForm = () => {
    setTarget('');
    setIndustry('');
    setCompetitors('');
    setAudience('');
    setTaskId(null);
    setView('form');
    setError(null);
  };
  
  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Market Research</h1>
      
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}
      
      {view === 'form' ? (
        <>
          <form onSubmit={handleSubmit} className="mb-8">
            <div className="mb-4">
              <label htmlFor="target" className="block text-gray-700 mb-2">
                Target Product/Service
              </label>
              <input
                type="text"
                id="target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
                required
              />
            </div>
            
            <div className="mb-4">
              <label htmlFor="industry" className="block text-gray-700 mb-2">
                Industry
              </label>
              <input
                type="text"
                id="industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
                required
              />
            </div>
            
            <div className="mb-4">
              <label htmlFor="competitors" className="block text-gray-700 mb-2">
                Competitors (comma-separated)
              </label>
              <input
                type="text"
                id="competitors"
                value={competitors}
                onChange={(e) => setCompetitors(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            
            <div className="mb-4">
              <label htmlFor="audience" className="block text-gray-700 mb-2">
                Target Audience
              </label>
              <input
                type="text"
                id="audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
                required
              />
            </div>
            
            <button
              type="submit"
              className="bg-blue-500 text-white px-4 py-2 rounded"
              disabled={isLoading}
            >
              {isLoading ? 'Processing...' : 'Generate Market Research'}
            </button>
          </form>
          
          <div>
            <h2 className="text-xl font-semibold mb-3">Recent Research Tasks</h2>
            {isLoading && <p>Loading recent tasks...</p>}
            
            {recentTasks.length === 0 && !isLoading ? (
              <p>No recent tasks found.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {recentTasks.map((task) => (
                  <div
                    key={task.taskId}
                    className="border border-gray-300 rounded p-3 cursor-pointer hover:bg-gray-50"
                    onClick={() => loadTask(task.taskId)}
                  >
                    <p className="font-medium">{task.target}</p>
                    <p className="text-sm text-gray-500">
                      {new Date(task.createdAt).toLocaleString()}
                    </p>
                    <p className="text-sm mt-1">
                      <span
                        className={`px-2 py-1 rounded text-xs ${
                          task.status === 'completed'
                            ? 'bg-green-100 text-green-800'
                            : task.status === 'failed'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {task.status.charAt(0).toUpperCase() + task.status.slice(1)}
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div>
          <div className="flex justify-between mb-4">
            <h2 className="text-xl font-semibold">Research Results</h2>
            <button
              onClick={resetForm}
              className="bg-gray-200 px-3 py-1 rounded text-sm"
            >
              ← Back
            </button>
          </div>
          
          {isLoading ? (
            <p>Loading results...</p>
          ) : (
            <>
              {taskId && (
                <div>
                  <div className="mb-4 bg-gray-50 p-3 rounded">
                    <p><strong>Target:</strong> {target}</p>
                    <p><strong>Industry:</strong> {industry}</p>
                    <p><strong>Competitors:</strong> {competitors}</p>
                    <p><strong>Audience:</strong> {audience}</p>
                  </div>
                  
                  {recentTasks.find(t => t.taskId === taskId)?.execution?.result ? (
                    <div className="whitespace-pre-wrap bg-white p-4 border border-gray-300 rounded">
                      {recentTasks.find(t => t.taskId === taskId)?.execution?.result}
                    </div>
                  ) : (
                    <div className="text-center p-6 bg-gray-50 rounded">
                      <p className="mb-2">
                        {recentTasks.find(t => t.taskId === taskId)?.execution?.status === 'processing' 
                          ? 'Research in progress. This might take a few minutes.' 
                          : 'No results available yet.'}
                      </p>
                      {recentTasks.find(t => t.taskId === taskId)?.execution?.status === 'processing' && (
                        <div className="flex justify-center">
                          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default MarketResearch; 