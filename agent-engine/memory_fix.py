#!/usr/bin/env python3
"""
Memory system fix for browser-use agent.
This module provides utilities to fix the old_history table error.
"""

import os
import sqlite3
import tempfile
import shutil
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

def cleanup_memory_databases():
    """Clean up mem0 memory databases to fix old_history table error."""
    print("Cleaning up memory databases...")
    
    # Clear mem0 directories
    import glob
    mem0_dirs = glob.glob("/tmp/mem0_*")
    
    for mem0_dir in mem0_dirs:
        try:
            shutil.rmtree(mem0_dir)
            print(f"✅ Removed {mem0_dir}")
        except Exception as e:
            print(f"❌ Failed to remove {mem0_dir}: {e}")
    
    # Clear any SQLite databases that might have old_history table
    possible_db_locations = [
        os.path.expanduser("~/.mem0"),
        os.path.expanduser("~/mem0"),
        "/tmp/mem0",
        "./mem0",
        "./.mem0"
    ]
    
    for location in possible_db_locations:
        if os.path.exists(location):
            print(f"Checking {location} for database files...")
            
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

def setup_memory_environment():
    """Set up environment variables to prevent memory issues."""
    print("Setting up memory environment...")
    
    # Set environment variables to use a more stable memory configuration
    os.environ['MEM0_DATABASE_URL'] = 'sqlite:///:memory:'
    os.environ['MEM0_BACKEND'] = 'sqlite'
    
    # Alternative: disable memory entirely if issues persist
    # os.environ['MEM0_DISABLED'] = 'true'
    
    print("✅ Memory environment configured")

def create_memory_config():
    """Create a memory configuration file to prevent issues."""
    config_content = """
# Memory configuration for browser-use
# This file helps prevent the old_history table error

[MEMORY]
# Use in-memory database to avoid file conflicts
database_url = "sqlite:///:memory:"
backend = "sqlite"

# Alternative: disable memory entirely
# disabled = true
"""
    
    config_path = Path("mem0_config.ini")
    with open(config_path, 'w') as f:
        f.write(config_content)
    
    print(f"✅ Created memory config file: {config_path}")
    return config_path

def apply_memory_fix():
    """Apply the complete memory fix."""
    print("Applying memory fix...")
    
    # Step 1: Clean up existing memory databases
    cleanup_memory_databases()
    
    # Step 2: Set up environment variables
    setup_memory_environment()
    
    # Step 3: Create memory configuration
    create_memory_config()
    
    print("✅ Memory fix applied successfully")
    print("\nNext steps:")
    print("1. Try running your agent again")
    print("2. If issues persist, set MEM0_DISABLED=true")
    print("3. Or use a different memory backend")

if __name__ == "__main__":
    apply_memory_fix()
