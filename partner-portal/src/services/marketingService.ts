import axios from 'axios';
import { API_URL, buildApiUrl } from '../config';

// The marketing-agent backend URL
const MARKETING_API_URL = process.env.NODE_ENV === 'production' 
  ? 'https://api.marketing-agent.example.com' // Replace with actual production URL
  : 'http://localhost:3002'; // Assuming marketing-agent backend runs on port 3002

// Use the same API_URL from config.ts that's already used by the rest of the application
console.log('Using existing AgentWeb API URL from config:', API_URL);

const marketingApi = axios.create({
  baseURL: MARKETING_API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const agentWebApi = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Market research functions
interface MarketResearchParams {
  target?: string;
  industry?: string;
  competitors?: string[];
  audience?: string;
  prompt?: string;
}

export const createMarketResearch = async (params: MarketResearchParams, token: string) => {
  if (!token) {
    console.error('Error: No authentication token provided to createMarketResearch');
    throw new Error('Authentication token is required');
  }
  
  try {
    console.log('Creating market research task with params:', JSON.stringify(params));
    
    // Build a comprehensive research prompt using the format from agentWebService.ts
    const defaultPrompt = `Conduct a comprehensive market research for ${params.target || 'the specified target'}.

RESEARCH REQUIREMENTS:
1. Market Overview: Provide current market size, growth trends, and major market segments
2. Competitor Analysis: Identify key competitors${params.competitors?.length ? ` (including ${params.competitors.join(', ')})` : ''} and analyze their market share, strengths, and weaknesses
3. Target Audience: ${params.audience ? `Analyze the specified audience: ${params.audience}` : 'Identify and analyze key customer segments, their needs, and buying behaviors'}
4. SWOT Analysis: Strengths, weaknesses, opportunities, and threats in the market
5. Industry Trends: ${params.industry ? `Specific to the ${params.industry} industry` : 'Major trends shaping the industry'}, including technological advancements and regulatory changes
6. Pricing Analysis: Review of pricing strategies in the market
7. Distribution Channels: Analysis of how products/services reach customers

OUTPUT FORMAT:
- Executive Summary: Brief overview of key findings (1-2 paragraphs)
- Detailed Sections: Each requirement above should have its own clearly labeled section
- Data Visualization: Describe any relevant charts or graphs that would enhance the research
- Recommendations: Actionable insights based on the research findings
- Sources: List of data sources used for the research

Please provide comprehensive, data-backed analysis with specific examples and statistics where available.`;
    
    // Prepare the task data
    const taskData = {
      name: `Market Research ${params.target ? `for ${params.target}` : ''}`,
      prompt: params.prompt || defaultPrompt,
      isInteractive: false,
      isDeepResearch: false,
      emailNotification: false
    };
    
    console.log('Sending task creation request to:', buildApiUrl('/api/tasks'));
    
    // Create the task - Use the proper API endpoint with /api prefix
    const taskResponse = await agentWebApi.post('/api/tasks', taskData, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    console.log('Task created successfully:', taskResponse.data?.taskId);
    
    if (!taskResponse.data || !taskResponse.data.taskId) {
      throw new Error('Failed to create task - no taskId in response');
    }
    
    const taskId = taskResponse.data.taskId;
    
    console.log('Executing task:', taskId);
    
    // Execute the task - Use the proper API endpoint with /api prefix
    const executionResponse = await agentWebApi.post(`/api/tasks/${taskId}/execute`, {}, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    console.log('Task execution initiated:', executionResponse.data?.executionId);
    
    return {
      task: taskResponse.data,
      execution: executionResponse.data
    };
  } catch (error) {
    console.error('Error creating market research:', error);
    if (axios.isAxiosError(error)) {
      console.error('Response status:', error.response?.status);
      console.error('Response data:', error.response?.data);
    }
    throw error;
  }
};

export const getMarketResearch = async (taskId: string, token: string) => {
  if (!token) {
    console.error('Error: No authentication token provided to getMarketResearch');
    throw new Error('Authentication token is required');
  }
  
  try {
    console.log('Fetching task details for:', taskId);
    
    // Get task details - Use the proper API endpoint with /api prefix
    const taskResponse = await agentWebApi.get(`/api/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    console.log('Task details retrieved');
    
    // Get task executions - Use the proper API endpoint with /api prefix
    const executionsResponse = await agentWebApi.get(`/api/tasks/${taskId}/executions`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    console.log('Task executions retrieved');
    
    const task = taskResponse.data;
    
    // Add latest execution data if available
    if (executionsResponse.data && Array.isArray(executionsResponse.data) && executionsResponse.data.length > 0) {
      const latestExecution = executionsResponse.data[0];
      task.execution = latestExecution;
      
      // Use the execution result directly if it exists
      if (latestExecution.result) {
        task.execution.result = latestExecution.result;
      }
      
      // We're not fetching the log anymore - just use whatever data we already have
    }
    
    return task;
  } catch (error) {
    console.error('Error getting market research:', error);
    if (axios.isAxiosError(error)) {
      console.error('Response status:', error.response?.status);
      console.error('Response data:', error.response?.data);
    }
    throw error;
  }
};

export const getAllMarketResearch = async (token: string) => {
  if (!token) {
    console.error('Error: No authentication token provided to getAllMarketResearch');
    throw new Error('Authentication token is required');
  }
  
  try {
    console.log('Fetching all tasks from AgentWeb API');
    
    // Use the proper API endpoint with /api prefix
    const response = await agentWebApi.get('/api/tasks', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    console.log('Tasks retrieved successfully, count:', Array.isArray(response.data) ? response.data.length : 'not an array');
    
    if (!Array.isArray(response.data)) {
      console.error('Unexpected response format:', response.data);
      return [];
    }
    
    // Filter tasks that are market research tasks AND not archived
    const marketResearchTasks = response.data.filter((task: any) => 
      task.name && task.name.includes('Market Research') && task.status !== 'archived'
    );
    
    console.log('Filtered market research tasks, count:', marketResearchTasks.length);
    
    return marketResearchTasks;
  } catch (error) {
    console.error('Error getting all market research tasks:', error);
    if (axios.isAxiosError(error)) {
      console.error('Response status:', error.response?.status);
      console.error('Response data:', error.response?.data);
      
      // Handle specific error cases
      if (error.response?.status === 401) {
        console.error('Authentication error - token may be invalid or expired');
      } else if (error.response?.status === 404) {
        console.error('API endpoint not found - check API URL');
      } else if (error.response?.status === 403) {
        console.error('Permission denied');
      }
    }
    throw error;
  }
};

// Original marketing-agent API functions
export const getSocialMetrics = async () => {
  try {
    const response = await marketingApi.get('/api/social/metrics');
    return response.data;
  } catch (error) {
    console.error('Error fetching social metrics:', error);
    throw error;
  }
};

export const getSocialMentions = async () => {
  try {
    const response = await marketingApi.get('/api/social/mentions');
    return response.data;
  } catch (error) {
    console.error('Error fetching social mentions:', error);
    throw error;
  }
};

export const getCompetitorAnalysis = async (competitors: string[]) => {
  try {
    const response = await marketingApi.post('/api/market/competitors', { competitors });
    return response.data;
  } catch (error) {
    console.error('Error fetching competitor analysis:', error);
    throw error;
  }
};

// Reports endpoints
export const getReportById = async (reportId: string) => {
  try {
    const response = await marketingApi.get(`/api/reports/${reportId}`);
    return response.data;
  } catch (error) {
    console.error(`Error fetching report ${reportId}:`, error);
    throw error;
  }
};

export const createReport = async (reportData: any) => {
  try {
    const response = await marketingApi.post('/api/reports', reportData);
    return response.data;
  } catch (error) {
    console.error('Error creating report:', error);
    throw error;
  }
};

// Blog endpoints
export const getBlogPosts = async () => {
  try {
    const response = await marketingApi.get('/api/blog');
    return response.data;
  } catch (error) {
    console.error('Error fetching blog posts:', error);
    throw error;
  }
};

export default {
  getSocialMetrics,
  getSocialMentions,
  getCompetitorAnalysis,
  getReportById,
  createReport,
  getBlogPosts,
  createMarketResearch,
  getMarketResearch,
  getAllMarketResearch
}; 