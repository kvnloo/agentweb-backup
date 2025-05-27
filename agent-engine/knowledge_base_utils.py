import os
from typing import List, Dict, Optional
from google.cloud import storage
from google.cloud import discoveryengine_v1
from google.cloud.discoveryengine_v1 import SearchRequest
from datetime import datetime
import json

class KnowledgeBaseManager:
    def __init__(self, project_id: str, location: str, data_store_id: str):
        """Initialize the Knowledge Base Manager.
        
        Args:
            project_id: Google Cloud project ID
            location: Location of the Vertex AI Search instance (e.g., 'global')
            data_store_id: ID of the Vertex AI Search datastore
        """
        self.project_id = project_id
        self.location = location
        self.data_store_id = data_store_id
        self.storage_client = storage.Client()
        self.discovery_client = discoveryengine_v1.SearchServiceClient()
        
    def save_knowledge(self, content: str, metadata: Dict, bucket_name: str) -> str:
        """Save new knowledge to GCS bucket for indexing.
        
        Args:
            content: The knowledge content to save
            metadata: Additional metadata about the knowledge
            bucket_name: Name of the GCS bucket
            
        Returns:
            str: The GCS object path
        """
        bucket = self.storage_client.bucket(bucket_name)
        
        # Create a unique filename with timestamp
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"knowledge_{timestamp}.json"
        
        # Combine content and metadata
        knowledge_data = {
            "content": content,
            "metadata": metadata,
            "timestamp": timestamp
        }
        
        # Upload to GCS
        blob = bucket.blob(filename)
        blob.upload_from_string(
            json.dumps(knowledge_data),
            content_type='application/json'
        )
        
        return f"gs://{bucket_name}/{filename}"
    
    def search_knowledge(self, query: str, max_results: int = 5) -> List[Dict]:
        """Search the knowledge base using Vertex AI Search.
        
        Args:
            query: The search query
            max_results: Maximum number of results to return
            
        Returns:
            List[Dict]: List of search results with content and metadata
        """
        # Construct the full resource name
        serving_config = self.discovery_client.serving_config_path(
            project=self.project_id,
            location=self.location,
            data_store=self.data_store_id,
            serving_config="default_config"
        )
        
        # Create search request
        request = SearchRequest(
            serving_config=serving_config,
            query=query,
            page_size=max_results
        )
        
        # Execute search
        response = self.discovery_client.search(request)
        
        # Process and return results
        results = []
        for result in response.results:
            results.append({
                "content": result.document.derived_struct_data.get("content", ""),
                "metadata": result.document.derived_struct_data.get("metadata", {})
            })
            
        return results

def get_knowledge_base_manager() -> KnowledgeBaseManager:
    """Get a configured KnowledgeBaseManager instance using environment variables."""
    return KnowledgeBaseManager(
        project_id=os.getenv("GOOGLE_CLOUD_PROJECT"),
        location=os.getenv("VERTEX_AI_LOCATION", "global"),
        data_store_id=os.getenv("VERTEX_AI_DATASTORE_ID")
    ) 