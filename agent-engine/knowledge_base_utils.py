import os
from typing import List, Dict, Optional
from google.cloud import storage
from google.cloud import discoveryengine_v1 as discoveryengine
from google.cloud.discoveryengine_v1 import SearchRequest
from google.api_core.client_options import ClientOptions
from datetime import datetime
import json
import html

class KnowledgeBaseManager:
    def __init__(self, project_id: str, location: str, search_app_id: str):
        """Initialize the Knowledge Base Manager.
        
        Args:
            project_id: Google Cloud project ID
            location: Location of the Vertex AI Search instance (e.g., 'global')
            search_app_id: ID of the Vertex AI Search app (engine)
        """
        self.project_id = project_id
        self.location = location
        self.search_app_id = search_app_id
        self.storage_client = storage.Client()
        # Set client options for non-global locations
        if self.location != "global":
            client_options = ClientOptions(api_endpoint=f"{self.location}-discoveryengine.googleapis.com")
        else:
            client_options = None
        self.discovery_client = discoveryengine.SearchServiceClient(client_options=client_options)
        
    def save_knowledge(self, content: str, bucket_name: str) -> str:
        """Save new knowledge to GCS bucket for indexing.
        
        Args:
            content: The knowledge content to save
            bucket_name: Name of the GCS bucket
            
        Returns:
            str: The GCS object path
        """
        bucket = self.storage_client.bucket(bucket_name)
        
        # Create a unique filename with timestamp
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")  # Added microseconds for uniqueness
        filename = f"knowledge_{timestamp}.txt"
        
        # Upload raw content to GCS
        blob = bucket.blob(filename)
        blob.upload_from_string(
            content,
            content_type='text/plain'
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

        response = self.discovery_client.search(request)

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

def get_knowledge_base_manager(bucket_type: str = 'public') -> KnowledgeBaseManager:
    """Get a configured KnowledgeBaseManager instance using environment variables.
    
    Args:
        bucket_type (str): Type of knowledge base to get ('public' or 'private')
        
    Returns:
        KnowledgeBaseManager: Configured knowledge base manager instance
    """
    if bucket_type == 'private':
        return KnowledgeBaseManager(
            project_id=os.getenv("GOOGLE_CLOUD_PROJECT"),
            location=os.getenv("VERTEX_AI_LOCATION_PRIVATE", "global"),
            search_app_id=os.getenv("VERTEX_AI_SEARCH_APP_ID_PRIVATE")
        )
    else:
        return KnowledgeBaseManager(
            project_id=os.getenv("GOOGLE_CLOUD_PROJECT"),
            location=os.getenv("VERTEX_AI_LOCATION", "global"),
            search_app_id=os.getenv("VERTEX_AI_SEARCH_APP_ID")
        ) 