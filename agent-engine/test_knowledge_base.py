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

def test_search_knowledge():
    """Test searching knowledge base"""
    # Get the knowledge base manager
    kb_manager = get_knowledge_base_manager()
    
    # Test searching knowledge
    query = "lazy dog"  # Simple query to match any content containing "dog"
    results = kb_manager.search_knowledge(query, max_results=5)
    
    # Print results
    print(f"\nSearch Results for '{query}':")
    for i, result in enumerate(results, 1):
        print(f"\nResult {i}:")
        print(f"Content: {result['content']}")
        # Debug: Print the full structure of the result
        print(f"Full result structure: {result}")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        test_type = sys.argv[1].lower()
        if test_type == "save_freetext":
            test_save_knowledge_freetext()
        elif test_type == "search":
            test_search_knowledge()
        else:
            print("Invalid test type. Use 'save_freetext' or 'search'")
    else:
        print("Please specify test type: 'save_freetext' or 'search'")
        print("Example: python test_knowledge_base.py save_freetext")
        print("Example: python test_knowledge_base.py search") 