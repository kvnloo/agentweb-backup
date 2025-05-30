# Setting up Google Cloud Vertex AI Search for AgentWeb

This guide provides step-by-step instructions for setting up Google Cloud Vertex AI Search (formerly Enterprise Search) for use with AgentWeb's agent-engine.

## Prerequisites

1. A Google Cloud project with billing enabled
2. The Google Cloud CLI (gcloud) installed and configured
3. Appropriate permissions to create and manage Vertex AI Search resources
4. The agent-engine VM instance running in Google Cloud

## Setup Steps

### 1. Enable Required APIs

```bash
# Login which will select the account and the project. Make sure to use agent-engine-460619
gcloud auth login

# Enable the Discovery Engine API
gcloud services enable discoveryengine.googleapis.com

# Enable the Cloud Storage API
gcloud services enable storage.googleapis.com
```

### 2. Create a Cloud Storage Bucket

```bash
# Create a new bucket with a unique name
# Note: Bucket names must be globally unique across all of Google Cloud
gcloud storage buckets create gs://agentweb-knowledge-base-dev \
    --project=107995268574 \
    --location=us-west1 \
    --uniform-bucket-level-access
```

### 3. Create a Vertex AI Search Datastore

The Vertex AI Search datastore needs to be created through the Google Cloud Console UI as the CLI commands are not currently available. Here are the steps:

1. Go to the Google Cloud Console: https://console.cloud.google.com
2. Make sure you're in the correct project (agent-engine-460619)
3. Navigate to Vertex AI Search in the left menu
4. Click "Create Datastore"
5. Configure the datastore with these settings:
   - Name: "agentweb-kb3"
   - Location: Global
   - Content Type: Unstructured
   - Solution Type: Search
6. Click "Create"

After creation, note down the following values for the environment variables:
- Datastore ID: "agentweb-kb_1748183084544"
- Location: US (multi-region)

### 4. Configure Environment Variables

Add the following environment variables to your environment:

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.) for local development
# Or to /etc/environment for VM deployment
GOOGLE_CLOUD_PROJECT=107995268574
VERTEX_AI_LOCATION=global
VERTEX_AI_SEARCH_APP_ID=agentweb-kb3_1748352686579
VERTEX_AI_DATASTORE_ID=agentweb-knowledge-base-connector-dev3_1748350752931_gcs_store
GCS_BUCKET_NAME=agentweb-knowledge-base-dev
```

### 5. Set Up Service Account

1. Create a service account:
```bash
gcloud iam service-accounts create agentweb-knowledge-base \
    --display-name="AgentWeb Knowledge Base Service Account"
```

2. Grant necessary permissions:
```bash
# Grant Storage Object Admin role
gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:agentweb-knowledge-base@107995268574.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"

# Grant Discovery Engine User role
gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:agentweb-knowledge-base@107995268574.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.user"
```

### 6. Authentication Setup

#### Option 1: Service Account Key File (Recommended)

1. Create and download a service account key:
```bash
# Create a key file for the service account
gcloud iam service-accounts keys create vertex-ai-search-key.json \
    --iam-account=agentweb-knowledge-base@107995268574.iam.gserviceaccount.com
```

2. Set the environment variable:
```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.) for local development
# Or to /etc/environment for VM deployment
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/vertex-ai-search-key.json"
```

3. For VM deployment, copy the key file to a secure location:
```bash
# Copy the key file to the VM
gcloud compute scp vertex-ai-search-key.json YOUR_VM_NAME:/path/to/secure/location/ --zone=YOUR_ZONE
```

#### Option 2: Application Default Credentials

For local development, you can use application default credentials:

```bash
# Login with your user account
gcloud auth login

# Set up application default credentials
gcloud auth application-default login
```

This will:
1. Open a browser window for authentication
2. Create credentials that last for 1 hour
3. Store them in `~/.config/gcloud/application_default_credentials.json`

Note: You'll need to manually refresh the credentials when they expire (every hour) by running `gcloud auth application-default login` again.

#### Option 3: Workload Identity Federation (For AWS Elastic Beanstalk)

If you're using AWS Elastic Beanstalk, you can use Workload Identity Federation:

1. Enable the IAM API in your Google Cloud project:
```bash
gcloud services enable iamcredentials.googleapis.com
```

2. Create a Workload Identity Pool:
```bash
# Create a Workload Identity Pool
gcloud iam workload-identity-pools create "aws-pool" \
    --location="global" \
    --display-name="AWS Pool"

# Get the Workload Identity Pool ID
WORKLOAD_IDENTITY_POOL_ID=$(gcloud iam workload-identity-pools describe "aws-pool" \
    --location="global" \
    --format="value(name)")

# Create a Workload Identity Provider for AWS
gcloud iam workload-identity-pools providers create-aws "aws-provider" \
    --location="global" \
    --workload-identity-pool="aws-pool" \
    --account-id="992382574572"

# Get the provider resource name
PROVIDER_NAME=$(gcloud iam workload-identity-pools providers describe "aws-provider" \
    --location="global" \
    --workload-identity-pool="aws-pool" \
    --format="value(name)")

# Create a service account for AWS workloads
gcloud iam service-accounts create aws-workload-sa \
    --display-name="AWS Workload Service Account"

# Grant necessary permissions to the service account
gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:aws-workload-sa@agent-engine-460619.iam.gserviceaccount.com" \
    --role="roles/storage.admin"

gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:aws-workload-sa@agent-engine-460619.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.user"

# Allow the AWS provider to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding aws-workload-sa@agent-engine-460619.iam.gserviceaccount.com \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/${WORKLOAD_IDENTITY_POOL_ID}/attribute.aws_role/arn:aws:iam::992382574572:role/service-role/aws-elasticbeanstalk-service-role"
```

### 7. Verify Setup

1. Create a .env file in your agent-engine directory:
```bash
# Create .env file
cat > .env << EOL
GOOGLE_CLOUD_PROJECT=107995268574
VERTEX_AI_LOCATION=global
VERTEX_AI_SEARCH_APP_ID=agentweb-kb3_1748352686579
VERTEX_AI_DATASTORE_ID=agentweb-knowledge-base-connector-dev3_1748350752931_gcs_store
GCS_BUCKET_NAME=agentweb-knowledge-base-dev
GOOGLE_APPLICATION_CREDENTIALS=/path/to/vertex-ai-search-key.json
EOL
```

2. Test the knowledge base connection:
```bash
# Make sure you're in the agent-engine directory
cd agent-engine

# Test the connection
python -c "
from dotenv import load_dotenv
load_dotenv()  # Load environment variables from .env
from knowledge_base_utils import get_knowledge_base_manager
kb = get_knowledge_base_manager()
results = kb.search_knowledge('test query')
print('Connection successful!' if results is not None else 'Connection failed')
"
```

## Usage

The knowledge base can be used in your agent code like this:

```python
from knowledge_base_utils import get_knowledge_base_manager

# Get knowledge base manager
kb = get_knowledge_base_manager()

# Save new knowledge
kb.save_knowledge(
    content="Your knowledge content here",
    metadata={"source": "task_execution", "task_id": "123"},
    bucket_name=os.getenv("GCS_BUCKET_NAME")
)

# Search knowledge
results = kb.search_knowledge("your search query")
```

## Maintenance

### Monitoring

1. Set up Cloud Monitoring alerts for:
   - Storage bucket usage
   - API quota usage
   - Error rates

2. Monitor costs in the Google Cloud Console:
   - Vertex AI Search usage
   - Storage usage
   - API calls

### Backup

1. Consider setting up bucket versioning:
```bash
gcloud storage buckets update gs://agentweb-knowledge-base-dev --versioning
```

### Troubleshooting

1. Check API quotas in Google Cloud Console
2. Verify service account permissions
3. Check environment variables are set correctly
4. Monitor Cloud Logging for errors

## Security Considerations

1. Use minimal required permissions
2. Enable audit logging
3. Monitor for unusual activity

## Cost Optimization

1. Set up budget alerts
2. Monitor storage usage
3. Clean up old knowledge entries
4. Use appropriate storage classes
5. Set up lifecycle policies for the bucket

### 2. VM Deployment

Since you already have a VM instance with a default service account (107995268574-compute@developer.gserviceaccount.com), follow these steps to set up the necessary permissions:

#### Option 1: Using Google Cloud Console UI

1. Go to the Google Cloud Console: https://console.cloud.google.com
2. Navigate to Compute Engine > VM instances
3. Find your VM instance and click on it
4. Click "Edit" (pencil icon)
5. Scroll down to "Access scopes"
6. Choolse "Allow full access to all Cloud APIs"
8. Click "Save"
9. The VM will be restarted automatically

#### After configuring scopes

1. Grant necessary permissions to the default service account:
```bash
gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:107995268574-compute@developer.gserviceaccount.com" \
    --role="roles/aiplatform.user"

gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:107995268574-compute@developer.gserviceaccount.com" \
    --role="roles/storage.admin"

gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:107995268574-compute@developer.gserviceaccount.com" \
    --role="roles/discoveryengine.user"
```

2. SSH into your VM:
```bash
gcloud compute ssh YOUR_VM_NAME --zone=YOUR_ZONE
```

3. On the VM, verify the service account is working:
```bash
# Verify the authentication
gcloud auth list
```

Note: Replace the following placeholders with your actual values:
- `YOUR_VM_NAME`: Your existing VM instance name
- `YOUR_ZONE`: The zone where your VM is located (e.g., us-central1-a)

### 3. Security Considerations

1. Follow the principle of least privilege:
   - Only grant the minimum necessary permissions to the service account
   - Regularly audit service account permissions
   - Consider removing unnecessary permissions

2. Monitor service account usage:
   - Enable Cloud Audit Logs
   - Set up alerts for unusual activity
   - Regularly review service account access patterns

### 4. Connecting AWS Elastic Beanstalk to GCS

You have two options to connect your AWS Elastic Beanstalk backend to Google Cloud Storage:

#### Option A: Using Workload Identity Federation (Recommended)

Workload Identity Federation allows your AWS workloads to access Google Cloud resources without using service account keys. This is more secure as it eliminates the need to manage and rotate service account keys.

1. Enable the IAM API in your Google Cloud project:
```bash
gcloud services enable iamcredentials.googleapis.com
```

2. Create a Workload Identity Pool:
```bash
# Create a Workload Identity Pool
gcloud iam workload-identity-pools create "aws-pool" \
    --location="global" \
    --display-name="AWS Pool"

# Get the Workload Identity Pool ID
WORKLOAD_IDENTITY_POOL_ID=$(gcloud iam workload-identity-pools describe "aws-pool" \
    --location="global" \
    --format="value(name)")

# Create a Workload Identity Provider for AWS
gcloud iam workload-identity-pools providers create-aws "aws-provider" \
    --location="global" \
    --workload-identity-pool="aws-pool" \
    --account-id="992382574572"

# Get the provider resource name
PROVIDER_NAME=$(gcloud iam workload-identity-pools providers describe "aws-provider" \
    --location="global" \
    --workload-identity-pool="aws-pool" \
    --format="value(name)")

# Create a service account for AWS workloads
gcloud iam service-accounts create aws-workload-sa \
    --display-name="AWS Workload Service Account"

# Grant necessary permissions to the service account
gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:aws-workload-sa@agent-engine-460619.iam.gserviceaccount.com" \
    --role="roles/storage.admin"

gcloud projects add-iam-policy-binding 107995268574 \
    --member="serviceAccount:aws-workload-sa@agent-engine-460619.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.user"

# Allow the AWS provider to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding aws-workload-sa@agent-engine-460619.iam.gserviceaccount.com \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/${WORKLOAD_IDENTITY_POOL_ID}/attribute.aws_role/arn:aws:iam::992382574572:role/service-role/aws-elasticbeanstalk-service-role"
```