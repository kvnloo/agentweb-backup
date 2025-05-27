import os
from dotenv import load_dotenv
from knowledge_base_utils import get_knowledge_base_manager

# Load environment variables from .env file
load_dotenv()

def test_save_knowledge():
    """Test saving knowledge to GCS bucket"""
    # Get the knowledge base manager
    kb_manager = get_knowledge_base_manager()
    
    # Test saving knowledge
    content = "This is a test knowledge entry"
    metadata = {
        "source": "test",
        "type": "test_entry",
        "description": "A test entry for knowledge base testing"
    }
    bucket_name = os.getenv("GCS_BUCKET_NAME")
    print(f"Using bucket: {bucket_name}")
    
    # Save knowledge
    result = kb_manager.save_knowledge(content, metadata, bucket_name)
    print(f"Saved knowledge to: {result}")

def test_search_knowledge():
    """Test searching knowledge base"""
    # Get the knowledge base manager
    kb_manager = get_knowledge_base_manager()
    
    # Test searching knowledge
    query = "test knowledge"
    results = kb_manager.search_knowledge(query, max_results=5)
    
    # Print results
    print("\nSearch Results:")
    for i, result in enumerate(results, 1):
        print(f"\nResult {i}:")
        print(f"Content: {result['content']}")
        print(f"Metadata: {result['metadata']}")
        # Debug: Print the full structure of the result
        print(f"Full result structure: {result}")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        test_type = sys.argv[1].lower()
        if test_type == "save":
            test_save_knowledge()
        elif test_type == "search":
            test_search_knowledge()
        else:
            print("Invalid test type. Use 'save' or 'search'")
    else:
        print("Please specify test type: 'save' or 'search'")
        print("Example: python test_knowledge_base.py save")
        print("Example: python test_knowledge_base.py search") 