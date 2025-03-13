# AgentWeb - Technical Design Document

## Overview
AgentWeb is a web platform that enables users to create and manage AI-powered web automation tasks using natural language instructions. The platform provides secure credential management, reliable task execution in isolated environments, and advanced features like deep research capabilities, workflows, and task templates.

## System Security Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   AgentWeb      │         │    AgentWeb     │         │    Web Agent    │
│    Frontend     │         │     Backend      │         │     Engine      │
│                 │         │                  │         │                 │
│  ┌───────────┐  │   1    │  ┌───────────┐   │    3    │ ┌───────────┐  │
│  │  User     │  │◄──────►│  │  Auth &   │   │◄───────►│ │ Isolated  │  │
│  │ Interface │  │   JWT   │  │  API      │   │  Task   │ │ Browser   │  │
│  └───────────┘  │         │  └───────────┘   │  Queue  │ │ Sessions  │  │
│        ▲        │         │        ▲         │         │ └───────────┘  │
│        │        │         │        │         │         │        ▲       │
│        │        │         │        │         │         │        │       │
│        │     2  │         │        │      4  │         │        │    5  │
│        └────────┼─────────┼────────┘         │         │        │       │
│   Credentials   │         │                   │         │        │       │
│   Input Only    │         │                   │         │        ▼       │
└─────────────────┘         └─────────────────┘         └─────────────────┘
                                                              Target
                                                             Websites
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
   - Backend schedules tasks in the Web Agent Engine
   - Task instructions and metadata only (no credentials)
   - Secure queue system for task management

4. **Task Execution Control (Flow 4)**
   - Backend monitors and controls task execution
   - Real-time status updates
   - Error handling and task termination capabilities

5. **Website Interaction (Flow 5)**
   - Isolated browser sessions per task
   - Fresh browser instance for each execution
   - No cross-task data sharing
   - Automatic session cleanup after task completion

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
   - Secure credential input interface
   - Workflow builder interface
   - Task templates management
   - Configuration management

2. **Backend**
   - Node.js/Express API server
   - Authentication and authorization system
   - Task orchestration engine
   - Browser session management
   - DynamoDB integration for data storage
   - Email notification system

3. **Agent Engine**
   - browser-use based automation
   - Isolated browser sessions per user
   - Task scheduling and queuing system
   - Error handling and retry mechanisms
   - Deep research capabilities
   - Interactive task execution
   - File upload/download handling
   - GIF generation for task visualization

4. **Security Layer**
   - JWT-based encryption for credentials
   - Secure credential handling
   - MFA implementation
   - Session isolation

### Infrastructure
1. **Compute**
   - AWS EC2 with Auto Scaling
   - Elastic Beanstalk for deployment
   - Docker containers for task isolation

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
- browser-use for web agent automation
- JWT for authentication
- AWS SDK for DynamoDB and S3 integration

### Agent Engine
- Python
- browser-use library
- LangChain integration
- Multiple LLM support (Azure OpenAI, AWS Bedrock, OpenAI, Google)
- Playwright for browser automation

### Infrastructure
- AWS (EC2, DynamoDB, S3, Elastic Beanstalk)
- Docker
- Nginx

### Monitoring
- AWS CloudWatch
- Custom logging system
- Execution tracking dashboard

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
1. **API marketplace for custom integrations**
2. **Machine learning for task optimization**
3. **Advanced credential delegation system**
4. **Mobile application**
5. **Enterprise features**
6. **AI-powered workflow suggestions**
7. **Workflow version control and rollback**
8. **Cross-organization workflow sharing**
9. **Advanced analytics dashboard**
10. **Integration with popular productivity tools** 