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
    def __init__(self, project_id: str, location: str, data_store_id: str, search_app_id: str):
        """Initialize the Knowledge Base Manager.
        
        Args:
            project_id: Google Cloud project ID
            location: Location of the Vertex AI Search instance (e.g., 'global')
            data_store_id: ID of the Vertex AI Search datastore
            search_app_id: ID of the Vertex AI Search app (engine)
        """
        self.project_id = project_id
        self.location = location
        self.data_store_id = data_store_id
        self.search_app_id = search_app_id
        self.storage_client = storage.Client()
        # Set client options for non-global locations
        if self.location != "global":
            client_options = ClientOptions(api_endpoint=f"{self.location}-discoveryengine.googleapis.com")
        else:
            client_options = None
        self.discovery_client = discoveryengine.SearchServiceClient(client_options=client_options)
        
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
        # Build the correct serving config path
        serving_config = (
            f"projects/{self.project_id}/locations/{self.location}/collections/default_collection/"
            f"engines/{self.search_app_id}/servingConfigs/default_config"
        )

        # Build content_search_spec using the SDK types
        content_search_spec = discoveryengine.SearchRequest.ContentSearchSpec(
            snippet_spec=discoveryengine.SearchRequest.ContentSearchSpec.SnippetSpec(
                return_snippet=True
            ),
            summary_spec=discoveryengine.SearchRequest.ContentSearchSpec.SummarySpec(
                summary_result_count=5,
                include_citations=True,
                ignore_adversarial_query=True,
                ignore_non_summary_seeking_query=True,
                # You can customize the prompt and model version if needed
                # model_prompt_spec=..., model_spec=...
            ),
        )

        request = discoveryengine.SearchRequest(
            serving_config=serving_config,
            query=query,
            page_size=max_results,
            content_search_spec=content_search_spec,
            query_expansion_spec=discoveryengine.SearchRequest.QueryExpansionSpec(
                condition=discoveryengine.SearchRequest.QueryExpansionSpec.Condition.AUTO
            ),
            spell_correction_spec=discoveryengine.SearchRequest.SpellCorrectionSpec(
                mode=discoveryengine.SearchRequest.SpellCorrectionSpec.Mode.AUTO
            ),
            # language_code="en-US",  # Uncomment if you want to specify language
        )

        response = self.discovery_client.search(request)

        results = []
        for result in response.results:
            # Print the full document for debugging
            print("DEBUG: Full document:", result.document)
            struct_data = result.document.derived_struct_data
            # Extract snippets
            snippets = struct_data.get("snippets", [])
            if snippets:
                # Assume the first snippet contains the content and metadata
                snippet = snippets[0]
                snippet_text = snippet.get("snippet", "")
                # Decode HTML and parse as JSON
                decoded_text = html.unescape(snippet_text)
                try:
                    snippet_data = json.loads(decoded_text)
                    results.append({
                        "content": snippet_data.get("content", ""),
                        "metadata": snippet_data.get("metadata", {}),
                        "raw": dict(struct_data)
                    })
                except json.JSONDecodeError:
                    print("Failed to parse snippet as JSON:", decoded_text)
            else:
                results.append({
                    "content": "",
                    "metadata": {},
                    "raw": dict(struct_data)
                })
        return results

def get_knowledge_base_manager() -> KnowledgeBaseManager:
    """Get a configured KnowledgeBaseManager instance using environment variables."""
    return KnowledgeBaseManager(
        project_id=os.getenv("GOOGLE_CLOUD_PROJECT"),
        location=os.getenv("VERTEX_AI_LOCATION", "global"),
        data_store_id=os.getenv("VERTEX_AI_DATASTORE_ID"),
        search_app_id=os.getenv("VERTEX_AI_SEARCH_APP_ID")
    ) 