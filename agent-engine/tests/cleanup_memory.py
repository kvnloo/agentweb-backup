#!/usr/bin/env python3
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
    
    print(f"\nCleanup complete. Fixed {cleaned_count} databases.")
    
    if cleaned_count == 0:
        print("No old_history tables found to clean up.")
        print("The error might be occurring during table creation.")
        print("Try running the agent again to see if the issue persists.")

if __name__ == "__main__":
    cleanup_memory_databases()
