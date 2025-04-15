# AgentWeb - Technical Design Document

## Overview
AgentWeb is a web platform that enables users to create and manage AI-powered web automation tasks using natural language instructions. The platform provides secure credential management, reliable task execution in isolated environments, and advanced features like deep research capabilities, workflows, and task templates.

## System Architecture Diagram

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────────────┐
│   AgentWeb      │         │    AgentWeb     │         │    Orchestration        │
│    Frontend     │         │     Backend      │         │    Layer - Google ADK   │
│                 │         │                  │         │                         │
│  ┌───────────┐  │   1    │  ┌───────────┐   │    3    │ ┌───────────────────┐  │
│  │  User     │  │◄──────►│  │  Auth &   │   │◄───────►│ │  Task Routing &   │  │
│  │ Interface │  │   JWT   │  │  API      │   │  Task   │ │  Orchestration    │  │
│  └───────────┘  │         │  └───────────┘   │ Request │ └───────────────────┘  │
│        ▲        │         │        ▲         │         │           │            │
│        │        │         │        │         │         │           │            │
│        │     2  │         │        │      4  │         │           │            │
│        └────────┼─────────┼────────┘         │         │           │            │
│   Credentials   │         │   Results        │         │           │            │
│   Input Only    │         │                  │         │           │            │
└─────────────────┘         └─────────────────┘         └─────────────┬───────────┘
                                                                      │
                                                                      │ 5. Route Tasks
                                                                      ▼
         ┌───────────────────────────────────────────────────────────────────────────────┐
         │                                                                               │
         │                            Agent Execution Platforms                          │
         │                                                                               │
         │  ┌────────────────────┐   ┌─────────────────────┐    ┌────────────────────┐  │
         │  │                    │   │                     │    │                    │  │
         │  │ Google Cloud       │   │ BrowserUse Engine   │    │  Future Platforms  │  │
         │  │ Agent Engine       │   │ (Website Navigation)│    │                    │  │
         │  │                    │   │                     │    │  - AWS Bedrock     │  │
         │  │                    │   │                     │    │  - OpenAI Agents   │  │
         │  │                    │   │                     │    │                    │  │
         │  └──────────┬─────────┘   └──────────┬──────────┘    └──────────┬─────────┘  │
         │             │                        │                          │            │
         └─────────────┼────────────────────────┼──────────────────────────┼────────────┘
                       │                        │                          │
                       │                        │ 6a. Web                  │
                       │ 6b. Google            │ Interaction              │ 6c. Other
                       │ Services              ▼                          │ Data Sources
                       ▼          ┌─────────────────────────────┐          ▼
           ┌────────────────────┐ │                             │ ┌──────────────────────┐
           │                    │ │                             │ │                      │
           │  Google Services   │ │       Websites              │ │  Other Agent         │
           │  - Google Search   │ │       - Login Pages         │ │  Data Sources        │
           │  - Google Maps     │ │       - Web Applications    │ │                      │
           │  - YouTube         │ │       - E-commerce          │ │                      │
           │  - Gmail           │ │       - SaaS Platforms      │ │                      │
           │                    │ │                             │ │                      │
           └────────────────────┘ └─────────────────────────────┘ └──────────────────────┘
```

### Security Boundaries and Data Flow

1. **User Authentication (Flow 1)**
   - Users authenticate with AgentWeb frontend
   - JWT tokens used for secure communication
   - MFA enabled for sensitive operations

2. **Credential Management (Flow 2)**
   - Credentials for target websites are input through frontend
   - Credentials are NEVER stored permanently
   - Each task requires fresh credential input
   - Credentials are transmitted securely using end-to-end encryption

3. **Task Orchestration (Flow 3)**
   - Backend sends task requests to the Google ADK orchestration layer
   - Task instructions and metadata only (no credentials at this stage)
   - Secure API communication between backend and ADK

4. **Task Results (Flow 4)**
   - ADK returns execution results to the backend
   - Real-time status updates
   - Error handling and task termination capabilities

5. **Task Routing (Flow 5)**
   - ADK routes tasks to the appropriate agent execution platform
   - Routing based on task requirements and platform capabilities
   - Orchestration of multiple agents when needed

6. **External System Interactions**
   - **Web Interaction (Flow 6a)**: BrowserUse Engine interacts with websites
     - Isolated browser sessions per task
     - Fresh browser instance for each execution
     - Credentials injected only during execution
     - No cross-task data sharing
     - Automatic session cleanup after task completion
   
   - **Google Services Interaction (Flow 6b)**: Google Cloud Agent Engine connects to Google services
     - Agents execute against Google Search, Maps, YouTube, Gmail, etc.
     - Managed environment provided by Google
     - Secure API access to Google services
   
   - **Other Data Sources (Flow 6c)**: Future platforms will connect to various data sources
     - AWS Bedrock agents will access AWS services and data sources
     - OpenAI agents will connect to appropriate data sources
     - Each platform uses its own secure connection methods

### Security Principles

1. **Credential Isolation**
   - No permanent storage of target website credentials
   - Credentials exist only during task execution
   - Separate browser sessions prevent credential leakage

2. **AgentWeb Account Security**
   - Standard user authentication for AgentWeb platform
   - MFA for account protection
   - Session management and automatic timeouts
   - No correlation between AgentWeb accounts and target website credentials

3. **Task Isolation**
   - Each task runs in its own browser instance
   - No shared cookies or session data between tasks
   - Memory wiping after task completion

## System Architecture

### High-Level Components
1. **Frontend**
   - React-based web application
   - User interface for task creation and management
   - Real-time task status monitoring
   - Secure credential input interface (Note: Credentials still not stored permanently)
   - Workflow builder interface
   - Task templates management
   - Configuration management

2. **Backend**
   - Node.js/Express API server
   - Authentication and authorization system
   - Task scheduling and management (interfacing with ADK)
   - DynamoDB integration for data storage
   - Email notification system
   - Receives results from the ADK orchestration layer

3. **Orchestration Layer (Google ADK)**
   - Central component based on Google Agent Development Kit (ADK).
   - Responsible for multi-agent orchestration.
   - Receives task requests from the AgentWeb Backend.
   - Routes tasks to appropriate agent execution platforms.
   - Aggregates results from agents and returns them to the Backend.
   - Connects to various agent platforms:
       - **Google Cloud Agent Engine:** Runs managed agents provided by Google.
       - **BrowserUse Agent Engine:** Executes agents specifically designed for browser automation and website navigation using the `browser-use` library.
       - **(Future) AWS Bedrock:** Integration point for running agents managed by AWS Bedrock.
       - **(Future) OpenAI Agents:** Integration point for leveraging OpenAI's agent capabilities.

4. **Agent Execution Platforms**
   - **Google Cloud Agent Engine:** Managed environment for executing Google's agents.
   - **BrowserUse Agent Engine:** Dedicated environment for running `browser-use` based agents for web interaction tasks. Requires separate deployment and management (e.g., on GCE VM as per README). Handles browser isolation, task execution, credential injection (scoped to task), and result/artifact generation (e.g., screenshots, GIFs).
   - Future platforms (Bedrock, OpenAI) will integrate via ADK.

5. **Security Layer**
   - JWT-based encryption for credentials during transit/temporary use.
   - Secure credential handling (credentials passed ephemerally to BrowserUse engine when needed).
   - MFA implementation for AgentWeb accounts.
   - Isolation between different agent execution environments managed by ADK.

### Infrastructure
1. **Compute**
   - **AgentWeb Frontend/Backend:** AWS Elastic Beanstalk (Node.js platform).
   - **BrowserUse Agent Engine:** Deployed separately, e.g., Google Cloud VM (as detailed in README) or containerized service. Requires resources capable of running browser instances.
   - **Google Cloud Agent Engine:** Managed service within Google Cloud Platform.
   - Potential future use of AWS Lambda/ECS for specific agent types via Bedrock.

2. **Database**
   - Amazon DynamoDB for scalable storage
   - Tables:
     - AW-Users: User accounts
     - AW-Tasks: Task definitions
     - AW-TaskExecutions: Task execution records
     - AW-Waitlist: Waitlist entries
     - AW-Subscribers: Task subscribers
     - AW-TaskSchedules: Task schedules
     - AW-Configs: User website configurations
     - AW-Workflows: Workflow definitions
     - AW-WorkflowExecutions: Workflow execution records
     - AW-TaskTemplates: Task templates

3. **Storage**
   - Amazon S3 for file storage
   - Task execution results
   - Screenshots and GIFs
   - Downloadable reports

4. **Monitoring & Logging**
   - CloudWatch integration
   - Alert system for task failures
   - Audit logging
   - Execution logs for debugging

## Security Design

### Credential Management
1. **Storage**
   - JWT-based encryption for credentials
   - End-to-end encryption for credentials
   - Temporary session-based access

2. **Access Control**
   - Role-based access control (RBAC)
   - Time-limited access tokens
   - IP-based restrictions (optional)

3. **Authentication**
   - Multi-factor authentication
   - Session management
   - Regular security audits

### Browser Session Isolation
1. **Per-User Sessions**
   - Dedicated browser instances
   - Memory and process isolation
   - Automatic session cleanup

## Task Management

### Task Types
1. **Single Tasks**
   - One-time execution
   - Immediate or scheduled
   - Result storage and notification
   - Interactive mode for user input during execution

2. **Recurring Tasks**
   - Configurable schedules (daily, weekly, monthly)
   - Status management (active, paused)
   - Failure handling and retries

3. **Deep Research Tasks**
   - Advanced research capabilities
   - Multiple LLM options
   - Detailed HTML reports
   - Source citations

4. **Workflows**
   - Multiple tasks in defined sequence
   - Conditional branching based on task results
   - Error handling and recovery strategies
   - Visual workflow builder interface

### Task Execution
1. **Pipeline**
   - Natural language processing
   - Task validation
   - Resource allocation
   - Execution
   - Result processing
   - Notification
   - Workflow state management
   - Task dependency resolution

2. **Monitoring**
   - Real-time status updates
   - Performance metrics
   - Error tracking
   - Resource usage monitoring
   - Workflow progress visualization
   - Task dependency graphs
   - GIF generation for visual task replay

### Task Templates
1. **Template Management**
   - Create and save task templates
   - Share templates with other users
   - Quick task creation from templates
   - Template categories and tags

## User Interaction

### Interactive Tasks
1. **User Input During Execution**
   - Real-time questions from the agent
   - User responses integrated into task flow
   - Timeout handling for responses
   - Execution continuation based on input

2. **Execution Visualization**
   - GIF generation of task execution
   - Step-by-step replay
   - Screenshot capture at key points

### Notifications
1. **Email Notifications**
   - Task completion notifications
   - Error alerts
   - Subscriber notifications with detailed results
   - Scheduled task reminders

2. **In-App Notifications**
   - Real-time execution status
   - Task completion alerts
   - Error notifications
   - Interactive task prompts

## Scalability

### Horizontal Scaling
1. **Compute Layer**
   - Auto-scaling EC2 instances
   - Load balancer distribution
   - Container orchestration

2. **Database Layer**
   - DynamoDB auto-scaling
   - Read/write capacity adjustment
   - Partition optimization

### Performance Optimization
1. **Resource Management**
   - Task queuing
   - Priority scheduling
   - Resource pooling
   - Concurrent task execution limits

## Technical Stack

### Frontend
- React.js
- TypeScript
- Material-UI
- Context API for state management

### Backend
- Node.js
- Express.js
- TypeScript
- JWT for authentication
- AWS SDK for DynamoDB and S3 integration

### Orchestration Layer
- Google Agent Development Kit (ADK)
- Multi-agent orchestration capabilities
- Agent routing and selection logic
- Result aggregation and processing

### Agent Execution Platforms
- **Google Cloud Agent Engine**
  - Managed agent execution environment
  - Access to Google services (Search, Maps, YouTube, Gmail)
  - Scalable and reliable execution infrastructure
  
- **BrowserUse Engine**
  - Python-based engine
  - browser-use library for web automation
  - Playwright for browser control
  - Browser isolation and security features
  - Screenshot and GIF generation capabilities
  
- **Future Platforms** (planned)
  - AWS Bedrock integration
  - OpenAI agents support
  - Custom agent deployment options

### Infrastructure
- AWS (DynamoDB, S3, Elastic Beanstalk) for AgentWeb components
- Google Cloud Platform for Agent Engine components
- Docker containerization
- Nginx for web serving

### Monitoring
- AWS CloudWatch
- Custom logging system
- Execution tracking dashboard
- Cross-platform monitoring capabilities

## Workflow Management

### Workflow Components
1. **Workflow Definition**
   - Task sequence and dependencies
   - Error handling rules
   - Data passing between tasks
   - Timeout configurations

2. **Workflow Engine**
   - Task orchestration
   - State management
   - Error recovery
   - Sequential execution handling

3. **Workflow Interface**
   - Visual workflow builder
   - Real-time execution monitoring
   - Debug and testing tools

### Workflow Security
1. **Access Control**
   - Workflow-level permissions
   - Task-level access restrictions
   - Credential scope management
   - Audit logging for workflow changes

2. **Data Management**
   - Secure inter-task data transfer
   - Temporary credential handling
   - Result data encryption
   - Clean-up procedures

## Configuration Management

### Website Configurations
1. **Configuration Storage**
   - Secure storage of website-specific configurations
   - Sharing options for configurations
   - Version management

2. **Configuration Types**
   - Login procedures
   - Navigation paths
   - Data extraction rules
   - Form submission templates

## Future Considerations
1. **Expanded agent platform integrations**
   - Integration with additional LLM providers through ADK
   - Custom agent deployment options for enterprise customers
   - Specialized agents for industry-specific tasks

2. **Advanced multi-agent workflows**
   - Complex workflows involving multiple specialized agents
   - Agent collaboration and knowledge sharing capabilities
   - Dynamic agent selection based on task performance

3. **Enhanced agent capabilities**
   - Multi-modal agents (text, image, audio processing)
   - Improved reasoning and planning abilities
   - Long-context memory and learning from past executions

4. **Platform evolution**
   - API marketplace for custom integrations
   - Machine learning for task optimization and agent selection
   - Advanced credential delegation system
   - Mobile application for monitoring and control
   - Enterprise features for large-scale deployment

5. **Workflow improvements**
   - AI-powered workflow suggestions
   - Workflow version control and rollback
   - Cross-organization workflow sharing
   - Advanced analytics dashboard
   - Integration with popular productivity tools 