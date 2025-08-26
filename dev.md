# Continue with Google not working in dev
It could be due to auth related code was changed and the change would require restart `npm run dev` in order for the Google Login to work again.

# prod deployment on AWS Beanstalk
June 03, 2025: a deployment to backend failed and it failed to revert back to previous version. Restarting the app server and rebuilt the environemnt not worked. To resolve the issue, we had to clone the environment and then pointed the dns record in route 53 to the new environment.

June 04, 2025: another outage of the backend. To resolve the issue and improve reliability, updated the environment to use t3-small instead of t3-micro as first option and t3-medium as second option. It was t3-micro then t3-small.

June 16, 2025:
# Known issues of Gemini model with browser use
Gemini models cannot work with the BaseModel argument with function call. Also it has a strange issue that require minimum 1 argument. We needed to add patch to use simpler argument for gemini models.

June 19, 2025
The latest version of browser-use (0.2.7) has an issue of using the same persistent storage for session data which mixed the cookie files from different users. 

June 21, 2025
When restoring a previous good version of browser-use, an issue about old_history table or index crash arised. It was initially suspected to be issue with browser use or playwright but after several round of testings the issue was with the memory dependency of browser use. Uninstall the component solved the issue as this is not a hard dependency:
`pip uninstall -y mem0ai`
To reinstall it, run
`pip install "browser-use[memory]"`

Issue with reverted PRs: when there are reverted PRs, there is risk that changes may mess up, possibly due to accumulated changes are too many that github seems may start truncate. We encountered such issue when deploying the data analysis PR. A resolution was to start clean which causes much less confusion.

July 28, 2025
# DynamoDB Index Management

## Adding UserIdIndex to TaskExecutions Table

When deploying the Images feature, you may encounter an error: `ValidationException: The table does not have the specified index: UserIdIndex`. This happens because the TaskExecutions table is missing the UserIdIndex that's required for the `getAllTaskExecutionsByUserId` method.

### Manual Fix via AWS Management Console

1. **Access DynamoDB Console**
   - Go to AWS Management Console
   - Navigate to DynamoDB service
   - Click on "Tables" in the left sidebar

2. **Select the TaskExecutions Table**
   - Find the table named `Dev-AW-TaskExecutions` (development) or `AW-TaskExecutions` (production)
   - Click on the table name to open its details

3. **Add the Index**
   - In the table details page, scroll down to the "Indexes" section
   - Click "Create index" button
   - Fill in the following details:
     - **Partition key**: `userId` (String)
     - **Sort key**: `startTime` (String)
     - **Index name**: `UserIdIndex`
     - **Index capacity**: Copy from base table
     - **Attribute project**: All
   - Click "Create index"

4. **Wait for Index Creation**
   - The index will show "Creating" status initially
   - This process can take several minutes depending on table size
   - Monitor the status until it changes to "Active"

5. **Verify the Index**
   - Once the index is active, you can verify it by:
     - Going back to the table's "Indexes" section
     - Confirming `UserIdIndex` shows "Active" status
     - The index should have `userId` as partition key and `startTime` as sort key

### Prevention for Future Deployments

The `create-tables.ts` script has been updated to include the `UserIdIndex` by default for new deployments. This ensures that future table creations will automatically include the required index.

August 07, 2025
testing with gpt-5 models: Azure does offer gpt-5-chat but has insufficient quota error; OpenAI offers all models but gpt-5 require removal of temperature but even after it is removed, it is not responding to extract-content call. gpt-5-chat-latest has error about tools not supported

August 25, 2025
deploying Growth Genius: creating a beanstalk service could easily got stuck because it would just fail: create a new environment failed, copy from customer portal environment and then deploy the genius app failed. It may not be able to recover from failure.

August 26, 2025
# Growth Genius Frontend Deployment on AWS Elastic Beanstalk

## Key Deployment Learnings

### 1. ES Modules vs CommonJS Compatibility

**Problem**: The deployment failed with `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express'` despite having the correct import statement.

**Root Cause**: 
- `package.json` declared `"type": "module"` (ES Modules)
- `server.js` was using ES Module syntax (`import express from 'express'`)
- But `express` dependency was missing from `package.json`

**Solution**: 
- Added `"express": "^4.17.1"` to dependencies
- Ensured all required server dependencies are explicitly listed

**Lesson**: When converting from CommonJS to ES Modules, ensure all server dependencies are properly declared in package.json.

### 2. Port Configuration for Elastic Beanstalk

**Problem**: Initial deployment used port 3000, but Elastic Beanstalk expects port 8080.

**Solution**: 
```javascript
// Correct for Elastic Beanstalk
const PORT = process.env.PORT || 8080;
```

**Lesson**: Elastic Beanstalk environments typically expect applications to listen on port 8080, not 3000.

### 3. Module System Conversion Challenges

**Problem**: Converting `server.js` from CommonJS to ES Modules required handling `__dirname` replacement.

**Solution**: 
```javascript
import { fileURLToPath } from 'url';
import path from 'path';

// Replicate __dirname behavior in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

**Lesson**: ES Modules don't have `__dirname` by default, requiring manual replication for path operations.

### 4. Dependency Management for Production

**Critical Dependencies for Frontend + Server**:
- `express`: Required for serving static files and handling requests
- All frontend dependencies: React, Vite, etc.
- Server-specific utilities: path, url modules

**Lesson**: Frontend applications that include a Node.js server need both frontend and server dependencies in package.json.

### 5. Build and Deployment Process

**Successful Build Command**:
```bash
cd growth-chat && \
npm install && \
npm run build && \
zip -r growth-chat-deploy.zip . -x "node_modules/*" "src/*" ".git/*" "*.log"
```

**Key Points**:
- Install dependencies before building
- Build creates `dist/` folder with static assets
- Exclude development files from deployment zip
- Include `server.js` and `package.json` in deployment

### 6. Health Check and Monitoring

**Initial Misconception**: Thought frontend needed health check endpoint like backend.

**Reality**: Frontend applications typically don't need custom health endpoints for Elastic Beanstalk.

**Lesson**: Don't over-engineer - frontend health checks are handled by the load balancer reaching the running service.

### 7. Environment Variable Configuration

**Required for Growth Genius**:
```bash
PORT=8080
FRONTEND_URL=https://your-domain.com
GROWTH_GENIUS_CHAT_URL=https://your-domain.com
```

**Lesson**: Ensure all environment variables are properly configured in Elastic Beanstalk environment.

## Deployment Checklist

- [ ] All server dependencies in package.json
- [ ] Correct port configuration (8080 for Elastic Beanstalk)
- [ ] ES Module compatibility (if using "type": "module")
- [ ] Build process creates dist/ folder
- [ ] Deployment zip includes server.js and package.json
- [ ] Environment variables configured
- [ ] No development files in deployment

## Common Failure Points

1. **Missing Dependencies**: Server can't start due to missing packages
2. **Port Mismatch**: Service binds to wrong port
3. **Module System**: ES Module vs CommonJS incompatibility
4. **Build Issues**: Missing dist/ folder or build artifacts
5. **Environment Config**: Missing or incorrect environment variables