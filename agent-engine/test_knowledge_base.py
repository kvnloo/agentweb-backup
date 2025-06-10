import os
import time
from dotenv import load_dotenv
from knowledge_base_utils import get_knowledge_base_manager

# Load environment variables from .env file
load_dotenv()

def test_save_knowledge_freetext(bucket_type='public'):
    """Test saving free text knowledge to GCS bucket
    
    Args:
        bucket_type (str): Type of bucket to use ('public' or 'private')
    """
    # Get the knowledge base manager for the specified bucket type
    kb_manager = get_knowledge_base_manager(bucket_type)
    bucket_name = os.getenv("GCS_BUCKET_NAME") if bucket_type == 'public' else os.getenv("GCS_PRIVATE_BUCKET_NAME")
    print(f"Using {bucket_type} bucket: {bucket_name}")
    
    # Test data - just plain text content
    test_data = [
        "The quick brown fox jumps over the lazy dog",
        "Python is a high-level programming language",
        "My dog is named Max",
    ]
    
    # Save all test data
    print(f"\nSaving test data to {bucket_type} bucket...")
    for content in test_data:
        result = kb_manager.save_knowledge(content, bucket_name)
        print(f"Saved to: {result}")
        time.sleep(1)  # Sleep for 1 second between saves

def test_search_knowledge(query=None, max_results=5, max_content_length=200, bucket_type='both'):
    """Test searching knowledge base
    
    Args:
        query (str, optional): Search query. If None, will prompt for input.
        max_results (int, optional): Maximum number of results to return. Defaults to 5.
        max_content_length (int, optional): Maximum length of content to print. Defaults to 200.
        bucket_type (str, optional): Type of bucket to search ('public', 'private', or 'both'). Defaults to 'both'.
    """
    # If no query provided, prompt for input
    if query is None:
        query = input("\nEnter search query: ")
    
    if bucket_type == 'both':
        # Search both knowledge bases
        print("\n=== Searching Public Knowledge Base ===")
        public_kb = get_knowledge_base_manager('public')
        public_results = public_kb.search_knowledge(query, max_results=max_results)
        
        print("\n=== Searching Private Knowledge Base ===")
        private_kb = get_knowledge_base_manager('private')
        private_results = private_kb.search_knowledge(query, max_results=max_results)
        
        # Combine results
        results = public_results + private_results
    else:
        # Search single knowledge base
        kb_manager = get_knowledge_base_manager(bucket_type)
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

def test_both_knowledge_bases():
    """Test both public and private knowledge bases"""
    print("\n=== Testing Public Knowledge Base ===")
    test_save_knowledge_freetext(bucket_type='public')
    test_search_knowledge(query="Python", bucket_type='public')
    
    print("\n=== Testing Private Knowledge Base ===")
    test_save_knowledge_freetext(bucket_type='private')
    test_search_knowledge(query="Python", bucket_type='private')
    
    print("\n=== Testing Combined Search ===")
    test_search_knowledge(query="Python", bucket_type='both')

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        test_type = sys.argv[1].lower()
        if test_type == "save_freetext":
            bucket_type = sys.argv[2] if len(sys.argv) > 2 else 'public'
            test_save_knowledge_freetext(bucket_type)
        elif test_type == "search":
            # Get query from command line if provided
            query = sys.argv[2] if len(sys.argv) > 2 else None
            bucket_type = sys.argv[3] if len(sys.argv) > 3 else 'both'
            test_search_knowledge(query, bucket_type=bucket_type)
        elif test_type == "test_both":
            test_both_knowledge_bases()
        else:
            print("Invalid test type. Use 'save_freetext', 'search', or 'test_both'")
    else:
        print("Please specify test type: 'save_freetext', 'search', or 'test_both'")
        print("Example: python test_knowledge_base.py save_freetext [public|private]")
        print("Example: python test_knowledge_base.py search [query] [public|private|both]")
        print("Example: python test_knowledge_base.py test_both") 