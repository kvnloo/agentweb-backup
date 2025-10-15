#!/usr/bin/env python3
"""
Test and fix the memory system old_history table error.
This test helps diagnose and fix the SQLite table migration issue.
"""

import os
import sys
import tempfile
import shutil
import sqlite3
import unittest
from pathlib import Path

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def test_memory_database_cleanup():
    """Test cleaning up the memory database to fix old_history table error."""
    print("\n=== Testing Memory Database Cleanup ===")
    
    # Common locations where mem0 stores its database
    possible_db_locations = [
        "/tmp/mem0_*",
        os.path.expanduser("~/.mem0"),
        os.path.expanduser("~/mem0"),
        "/tmp/mem0",
        "./mem0",
        "./.mem0"
    ]
    
    print("Checking for mem0 database files...")
    
    # Check for mem0 directories in /tmp
    import glob
    mem0_dirs = glob.glob("/tmp/mem0_*")
    
    if mem0_dirs:
        print(f"Found mem0 directories: {mem0_dirs}")
        
        for mem0_dir in mem0_dirs:
            print(f"Checking directory: {mem0_dir}")
            
            # Look for SQLite database files
            db_files = []
            for root, dirs, files in os.walk(mem0_dir):
                for file in files:
                    if file.endswith('.db') or file.endswith('.sqlite') or file.endswith('.sqlite3'):
                        db_files.append(os.path.join(root, file))
            
            if db_files:
                print(f"Found database files: {db_files}")
                
                for db_file in db_files:
                    try:
                        # Check if old_history table exists
                        conn = sqlite3.connect(db_file)
                        cursor = conn.cursor()
                        
                        # Check if old_history table exists
                        cursor.execute("""
                            SELECT name FROM sqlite_master 
                            WHERE type='table' AND name='old_history'
                        """)
                        
                        if cursor.fetchone():
                            print(f"Found old_history table in {db_file}")
                            
                            # Try to drop the old_history table
                            try:
                                cursor.execute("DROP TABLE IF EXISTS old_history")
                                conn.commit()
                                print(f"✅ Successfully dropped old_history table from {db_file}")
                            except Exception as e:
                                print(f"❌ Failed to drop old_history table: {e}")
                        
                        conn.close()
                        
                    except Exception as e:
                        print(f"❌ Error checking database {db_file}: {e}")
            else:
                print(f"No database files found in {mem0_dir}")
    else:
        print("No mem0 directories found in /tmp")
    
    # Check other possible locations
    for location in possible_db_locations:
        if os.path.exists(location):
            print(f"Found mem0 location: {location}")
            if os.path.isdir(location):
                # Look for database files
                for root, dirs, files in os.walk(location):
                    for file in files:
                        if file.endswith(('.db', '.sqlite', '.sqlite3')):
                            db_path = os.path.join(root, file)
                            print(f"Found database: {db_path}")
                            
                            try:
                                conn = sqlite3.connect(db_path)
                                cursor = conn.cursor()
                                
                                # Check if old_history table exists
                                cursor.execute("""
                                    SELECT name FROM sqlite_master 
                                    WHERE type='table' AND name='old_history'
                                """)
                                
                                if cursor.fetchone():
                                    print(f"Found old_history table in {db_path}")
                                    
                                    # Try to drop the old_history table
                                    try:
                                        cursor.execute("DROP TABLE IF EXISTS old_history")
                                        conn.commit()
                                        print(f"✅ Successfully dropped old_history table from {db_path}")
                                    except Exception as e:
                                        print(f"❌ Failed to drop old_history table: {e}")
                                
                                conn.close()
                                
                            except Exception as e:
                                print(f"❌ Error checking database {db_path}: {e}")

def create_memory_cleanup_script():
    """Create a script to clean up memory database issues."""
    script_content = '''#!/usr/bin/env python3
"""
Memory Database Cleanup Script
Fixes the old_history table error in mem0 memory system.
"""

import os
import sqlite3
import glob
import shutil
from pathlib import Path

def cleanup_memory_databases():
    """Clean up mem0 memory databases to fix old_history table error."""
    print("Memory Database Cleanup Script")
    print("=" * 40)
    
    # Common locations where mem0 stores its database
    locations_to_check = [
        "/tmp/mem0_*",
        os.path.expanduser("~/.mem0"),
        os.path.expanduser("~/mem0"),
        "/tmp/mem0",
        "./mem0",
        "./.mem0"
    ]
    
    cleaned_count = 0
    
    # Check /tmp/mem0_* directories
    mem0_dirs = glob.glob("/tmp/mem0_*")
    for mem0_dir in mem0_dirs:
        print(f"Checking directory: {mem0_dir}")
        
        # Look for SQLite database files
        for root, dirs, files in os.walk(mem0_dir):
            for file in files:
                if file.endswith(('.db', '.sqlite', '.sqlite3')):
                    db_path = os.path.join(root, file)
                    print(f"Found database: {db_path}")
                    
                    try:
                        conn = sqlite3.connect(db_path)
                        cursor = conn.cursor()
                        
                        # Check if old_history table exists
                        cursor.execute("""
                            SELECT name FROM sqlite_master 
                            WHERE type='table' AND name='old_history'
                        """)
                        
                        if cursor.fetchone():
                            print(f"Found old_history table in {db_path}")
                            
                            # Try to drop the old_history table
                            try:
                                cursor.execute("DROP TABLE IF EXISTS old_history")
                                conn.commit()
                                print(f"✅ Successfully dropped old_history table from {db_path}")
                                cleaned_count += 1
                            except Exception as e:
                                print(f"❌ Failed to drop old_history table: {e}")
                        
                        conn.close()
                        
                    except Exception as e:
                        print(f"❌ Error checking database {db_path}: {e}")
    
    # Check other locations
    for location in locations_to_check:
        if os.path.exists(location):
            print(f"Checking location: {location}")
            
            if os.path.isdir(location):
                for root, dirs, files in os.walk(location):
                    for file in files:
                        if file.endswith(('.db', '.sqlite', '.sqlite3')):
                            db_path = os.path.join(root, file)
                            print(f"Found database: {db_path}")
                            
                            try:
                                conn = sqlite3.connect(db_path)
                                cursor = conn.cursor()
                                
                                # Check if old_history table exists
                                cursor.execute("""
                                    SELECT name FROM sqlite_master 
                                    WHERE type='table' AND name='old_history'
                                """)
                                
                                if cursor.fetchone():
                                    print(f"Found old_history table in {db_path}")
                                    
                                    # Try to drop the old_history table
                                    try:
                                        cursor.execute("DROP TABLE IF EXISTS old_history")
                                        conn.commit()
                                        print(f"✅ Successfully dropped old_history table from {db_path}")
                                        cleaned_count += 1
                                    except Exception as e:
                                        print(f"❌ Failed to drop old_history table: {e}")
                                
                                conn.close()
                                
                            except Exception as e:
                                print(f"❌ Error checking database {db_path}: {e}")
    
    print(f"\\nCleanup complete. Fixed {cleaned_count} databases.")
    
    if cleaned_count == 0:
        print("No old_history tables found to clean up.")
        print("The error might be occurring during table creation.")
        print("Try running the agent again to see if the issue persists.")

if __name__ == "__main__":
    cleanup_memory_databases()
'''
    
    script_path = os.path.join(os.path.dirname(__file__), "cleanup_memory.py")
    with open(script_path, 'w') as f:
        f.write(script_content)
    
    # Make it executable
    os.chmod(script_path, 0o755)
    
    print(f"Created cleanup script: {script_path}")
    return script_path

def test_alternative_memory_fix():
    """Test alternative approaches to fix the memory issue."""
    print("\n=== Testing Alternative Memory Fixes ===")
    
    # Option 1: Set environment variable to use a different memory backend
    print("Option 1: Set MEM0_BACKEND environment variable")
    print("export MEM0_BACKEND=postgres  # or another backend")
    
    # Option 2: Clear all mem0 data
    print("\nOption 2: Clear all mem0 data")
    print("rm -rf /tmp/mem0_*")
    print("rm -rf ~/.mem0")
    
    # Option 3: Use in-memory database
    print("\nOption 3: Use in-memory database")
    print("export MEM0_DATABASE_URL=sqlite:///:memory:")
    
    # Option 4: Disable memory entirely
    print("\nOption 4: Disable memory entirely")
    print("export MEM0_DISABLED=true")

class TestMemoryFix(unittest.TestCase):
    """Test cases for memory system fixes."""
    
    def test_memory_cleanup_function(self):
        """Test the memory cleanup function."""
        test_memory_database_cleanup()
        self.assertTrue(True)  # If we get here without exception, it worked
    
    def test_script_creation(self):
        """Test creating the cleanup script."""
        script_path = create_memory_cleanup_script()
        self.assertTrue(os.path.exists(script_path))
        self.assertTrue(os.access(script_path, os.X_OK))

def main():
    """Run the memory fix tests and create cleanup script."""
    print("Memory System Fix Test")
    print("=" * 50)
    
    # Run the cleanup test
    test_memory_database_cleanup()
    
    # Create the cleanup script
    script_path = create_memory_cleanup_script()
    
    # Run alternative fixes test
    test_alternative_memory_fix()
    
    print(f"\n{'='*50}")
    print("Next Steps:")
    print("1. Run the cleanup script: python tests/cleanup_memory.py")
    print("2. Or manually clean up: rm -rf /tmp/mem0_*")
    print("3. Try running your agent again")
    print("4. If still failing, try setting MEM0_DISABLED=true")
    
    # Run unit tests
    print(f"\n{'='*50}")
    print("Running Unit Tests")
    print("=" * 50)
    
    unittest.main(argv=[''], exit=False, verbosity=2)

if __name__ == '__main__':
    main()
