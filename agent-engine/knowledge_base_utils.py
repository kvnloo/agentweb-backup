import os
from typing import List, Dict, Optional
from google.cloud import storage
from google.cloud import discoveryengine
from google.cloud.discoveryengine import DocumentServiceClient
from google.api_core.client_options import ClientOptions
from datetime import datetime
import json
import html
import re
import logging
from aws_utils import get_dynamodb_resource
from google.oauth2 import service_account

logger = logging.getLogger(__name__)

# Get table prefix based on NODE_ENV
TABLE_PREFIX = 'Dev-' if os.getenv('NODE_ENV') == 'development' else ''

def get_gcp_private_key():
    """Get the GCP private key from environment variable, replacing [NEWLINE] with actual newlines"""
    private_key = os.getenv('GCS_PRIVATE_KEY', '')
    return private_key.replace('[NEWLINE]', '\n')

class KnowledgeBaseManager:
    def __init__(self, project_id: str, location: str, search_app_id: str, bucket_type: str, datastore_id: str, collection_id: str, user_id: str = None):
        """Initialize the Knowledge Base Manager.
        
        Args:
            project_id: Google Cloud project ID
            location: Location of the Vertex AI Search instance (e.g., 'global')
            search_app_id: ID of the Vertex AI Search app (engine)
            bucket_type: Type of knowledge base ('public' or 'private')
            datastore_id: ID of the Vertex AI Search datastore
            collection_id: ID of the Vertex AI Search collection
            user_id: User ID for private knowledge base access
        """
        self.project_id = project_id
        self.location = location
        self.search_app_id = search_app_id
        self.bucket_type = bucket_type
        self.datastore_id = datastore_id
        self.collection_id = collection_id
        self.user_id = user_id
        self.storage_client = storage.Client()
        # Set client options for non-global locations
        if self.location != "global":
            client_options = ClientOptions(api_endpoint=f"{self.location}-discoveryengine.googleapis.com")
        else:
            client_options = None
        self.document_client = DocumentServiceClient(client_options=client_options)
        self.dynamodb = get_dynamodb_resource()
        
        self.bucket_name = os.getenv('GCS_BUCKET_NAME_PRIVATE' if bucket_type == 'private' else 'GCS_BUCKET_NAME')
        self.bucket = self.storage_client.bucket(self.bucket_name)
        
    def save_knowledge(self, content: str, bucket_name: str, file_path: str = None) -> str:
        """Save new knowledge to GCS bucket for indexing.
        
        Args:
            content: The knowledge content to save
            bucket_name: Name of the GCS bucket
            file_path: Optional file path to use. If None, a unique name will be generated.
            
        Returns:
            str: The GCS object path
        """
        bucket = self.storage_client.bucket(bucket_name)
        
        if file_path is None:
            # Create a unique filename with timestamp
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")  # Added microseconds for uniqueness
            file_path = f"knowledge_{timestamp}.txt"
        
        # Upload raw content to GCS
        blob = bucket.blob(file_path)
        blob.upload_from_string(
            content,
            content_type='text/plain'
        )
        
        return f"gs://{bucket_name}/{file_path}"
    
    def search_knowledge(self, query: str, max_results: int = 5) -> List[Dict]:
        """Search the knowledge base using Vertex AI Search.
        
        Args:
            query: The search query
            max_results: Maximum number of results to return
            
        Returns:
            List[Dict]: List of search results with content and metadata
        """
        # Build the correct serving config path
        serving_config = (
            f"projects/{self.project_id}/locations/{self.location}/collections/default_collection/"
            f"engines/{self.search_app_id}/servingConfigs/default_config"
        )

        # Build content_search_spec using the SDK types
        content_search_spec = discoveryengine.SearchRequest.ContentSearchSpec(
            extractive_content_spec=discoveryengine.SearchRequest.ContentSearchSpec.ExtractiveContentSpec(
                max_extractive_segment_count=max_results
            )
        )

        request = discoveryengine.SearchRequest(
            serving_config=serving_config,
            query=query,
            content_search_spec=content_search_spec,
            query_expansion_spec=discoveryengine.SearchRequest.QueryExpansionSpec(
                condition=discoveryengine.SearchRequest.QueryExpansionSpec.Condition.AUTO
            ),
            spell_correction_spec=discoveryengine.SearchRequest.SpellCorrectionSpec(
                mode=discoveryengine.SearchRequest.SpellCorrectionSpec.Mode.AUTO
            ),
        )

        response = self.document_client.search(request)

        results = []
        for result in response.results:
            struct_data = result.document.derived_struct_data
            
            # Extract extractive segments
            extractive_segments = struct_data.get("extractive_segments", [])
            if extractive_segments:
                for segment in extractive_segments:
                    # Get the content field from the segment
                    content = segment.get("content", "")
                    if content:
                        # For private knowledge base, check task ownership
                        if self.bucket_type == 'private':
                            # Extract taskId from the link
                            link = struct_data.get("link", "")
                            if not link:
                                continue
                                
                            # Extract taskId from the link path (e.g., gs://bucket/tasks/1740437136262/knowledge-base.txt)
                            task_id_match = re.search(r'/tasks/(\d+)/', link)
                            if not task_id_match:
                                continue
                                
                            task_id = task_id_match.group(1)
                            
                            # Check if task belongs to current user
                            try:
                                # Get task from DynamoDB using aws_utils
                                table = self.dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks')
                                response = table.get_item(Key={'taskId': task_id})
                                task = response.get('Item')
                                
                                if not task or task.get('userId') != self.user_id:
                                    logger.info(f"Skipping task {task_id} - not owned by user {self.user_id}")
                                    continue
                                    
                                # Task belongs to user, add to results
                                results.append({
                                    "content": content,
                                    "raw": dict(struct_data)
                                })
                                
                            except Exception as e:
                                logger.error(f"Error checking task ownership for {task_id}: {str(e)}")
                                continue
                        else:
                            # For public knowledge base, no ownership check needed
                            results.append({
                                "content": content,
                                "raw": dict(struct_data)
                            })
            else:
                results.append({
                    "content": "",
                    "raw": dict(struct_data)
                })
        return results

    def sync_knowledge(self):
        """Sync the knowledge base with Vertex AI Search
        
        Returns:
            dict: Result of the sync operation
        """
        try:
            if not self.datastore_id or not self.collection_id:
                raise ValueError(f"Missing required environment variables for {self.bucket_type} knowledge base sync")
            
            # Get the GCS URI for the bucket
            gcs_uri = f"gs://{self.bucket_name}/**"
            
            # Create the import request
            request = discoveryengine.ImportDocumentsRequest(
                parent=f"projects/{self.project_id}/locations/{self.location}/collections/{self.collection_id}/dataStores/{self.datastore_id}/branches/default_branch",
                gcs_source=discoveryengine.GcsSource(
                    input_uris=[gcs_uri],
                    data_schema="custom"
                ),
                reconciliation_mode=discoveryengine.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL
            )
            
            # Start the import operation
            operation = self.document_client.import_documents(request=request)
            
            # Wait for the operation to complete
            result = operation.result()
            
            return {
                "success": True,
                "message": f"Successfully synced {self.bucket_type} knowledge base",
                "result": result
            }
            
        except Exception as e:
            print(f"Error syncing {self.bucket_type} knowledge base: {str(e)}")
            return {
                "success": False,
                "message": f"Error syncing {self.bucket_type} knowledge base: {str(e)}",
                "error": str(e)
            }

def get_knowledge_base_manager(bucket_type: str = 'public', user_id: str = None) -> KnowledgeBaseManager:
    """Get a configured KnowledgeBaseManager instance using environment variables.
    
    Args:
        bucket_type (str): Type of knowledge base to get ('public' or 'private')
        user_id (str, optional): User ID for private knowledge base access
        
    Returns:
        KnowledgeBaseManager: Configured knowledge base manager instance
    """
    if bucket_type == 'private':
        if not user_id:
            raise ValueError("user_id is required for private knowledge base access")
        return KnowledgeBaseManager(
            project_id=os.getenv("GOOGLE_CLOUD_PROJECT"),
            location=os.getenv("VERTEX_AI_LOCATION_PRIVATE", "global"),
            search_app_id=os.getenv("VERTEX_AI_SEARCH_APP_ID_PRIVATE"),
            bucket_type='private',
            datastore_id=os.getenv('VERTEX_AI_DATASTORE_ID_PRIVATE'),
            collection_id=os.getenv('VERTEX_AI_COLLECTION_ID_PRIVATE'),
            user_id=user_id
        )
    else:
        return KnowledgeBaseManager(
            project_id=os.getenv("GOOGLE_CLOUD_PROJECT"),
            location=os.getenv("VERTEX_AI_LOCATION", "global"),
            search_app_id=os.getenv("VERTEX_AI_SEARCH_APP_ID"),
            bucket_type='public',
            datastore_id=os.getenv('VERTEX_AI_DATASTORE_ID'),
            collection_id=os.getenv('VERTEX_AI_COLLECTION_ID')
        ) 