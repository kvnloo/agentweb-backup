import os
import time
from dotenv import load_dotenv
from knowledge_base_utils import get_knowledge_base_manager

# Load environment variables from .env file
load_dotenv()

def test_save_knowledge_freetext():
    """Test saving free text knowledge to GCS bucket"""
    # Get the knowledge base manager
    kb_manager = get_knowledge_base_manager()
    bucket_name = os.getenv("GCS_BUCKET_NAME")
    print(f"Using bucket: {bucket_name}")
    
    # Test data - just plain text content
    test_data = [
        "The quick brown fox jumps over the lazy dog",
        "Python is a high-level programming language",
        "My dog is named Max",
    ]
    
    # Save all test data
    print("\nSaving test data...")
    for content in test_data:
        result = kb_manager.save_knowledge(content, bucket_name)
        print(f"Saved to: {result}")
        time.sleep(1)  # Sleep for 1 second between saves

def test_search_knowledge(query=None, max_results=5, max_content_length=200):
    """Test searching knowledge base
    
    Args:
        query (str, optional): Search query. If None, will prompt for input.
        max_results (int, optional): Maximum number of results to return. Defaults to 5.
        max_content_length (int, optional): Maximum length of content to print. Defaults to 200.
    """
    # Get the knowledge base manager
    kb_manager = get_knowledge_base_manager()
    
    # If no query provided, prompt for input
    if query is None:
        query = input("\nEnter search query: ")
    
    # Test searching knowledge
    results = kb_manager.search_knowledge(query, max_results=max_results)
    
    # Print results
    print(f"\nSearch Results for '{query}':")
    if not results:
        print("No results found.")
        return
        
    for i, result in enumerate(results, 1):
        print(f"\nResult {i}:")
        content = result.get('content', '')
        if len(content) > max_content_length:
            content = content[:max_content_length] + "..."
        print(f"Content: {content}")
        print(f"Score: {result.get('score', 'N/A')}")
        print(f"Source: {result.get('source', 'N/A')}")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        test_type = sys.argv[1].lower()
        if test_type == "save_freetext":
            test_save_knowledge_freetext()
        elif test_type == "search":
            # Get query from command line if provided
            query = sys.argv[2] if len(sys.argv) > 2 else None
            test_search_knowledge(query)
        else:
            print("Invalid test type. Use 'save_freetext' or 'search'")
    else:
        print("Please specify test type: 'save_freetext' or 'search'")
        print("Example: python test_knowledge_base.py save_freetext")
        print("Example: python test_knowledge_base.py search")
        print("Example: python test_knowledge_base.py search 'your search query'") 