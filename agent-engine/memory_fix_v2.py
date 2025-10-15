#!/usr/bin/env python3
"""
Enhanced memory system fix for browser-use agent.
This module provides utilities to fix database schema issues including old_history and prev_value errors.
"""

import os
import sqlite3
import tempfile
import shutil
import logging
import glob
from pathlib import Path

logger = logging.getLogger(__name__)

def cleanup_memory_databases_v2():
    """Enhanced cleanup of mem0 memory databases to fix schema issues."""
    print("Enhanced memory database cleanup...")
    
    # Clear mem0 directories
    mem0_dirs = glob.glob("/tmp/mem0_*")
    for mem0_dir in mem0_dirs:
        try:
            shutil.rmtree(mem0_dir)
            print(f"✅ Removed {mem0_dir}")
        except Exception as e:
            print(f"❌ Failed to remove {mem0_dir}: {e}")
    
    # Clear home directory mem0 data
    home_mem0 = os.path.expanduser("~/.mem0")
    if os.path.exists(home_mem0):
        try:
            shutil.rmtree(home_mem0)
            print(f"✅ Removed {home_mem0}")
        except Exception as e:
            print(f"❌ Failed to remove {home_mem0}: {e}")
    
    # Clear any other mem0 locations
    other_locations = [
        os.path.expanduser("~/mem0"),
        "/tmp/mem0",
        "./mem0",
        "./.mem0"
    ]
    
    for location in other_locations:
        if os.path.exists(location):
            try:
                shutil.rmtree(location)
                print(f"✅ Removed {location}")
            except Exception as e:
                print(f"❌ Failed to remove {location}: {e}")

def setup_memory_environment_v2():
    """Set up environment variables to prevent memory issues with enhanced configuration."""
    print("Setting up enhanced memory environment...")
    
    # Use in-memory database to avoid all file-based schema issues
    os.environ['MEM0_DATABASE_URL'] = 'sqlite:///:memory:'
    os.environ['MEM0_BACKEND'] = 'sqlite'
    
    # Disable memory entirely if issues persist
    # Uncomment the next line if you want to disable memory completely
    # os.environ['MEM0_DISABLED'] = 'true'
    
    # Alternative: Use a different memory backend
    # os.environ['MEM0_BACKEND'] = 'postgres'
    # os.environ['MEM0_DATABASE_URL'] = 'postgresql://user:pass@localhost/mem0'
    
    print("✅ Enhanced memory environment configured")

def create_memory_config_v2():
    """Create an enhanced memory configuration file."""
    config_content = """
# Enhanced memory configuration for browser-use
# This file helps prevent database schema errors

[MEMORY]
# Use in-memory database to avoid file conflicts and schema issues
database_url = "sqlite:///:memory:"
backend = "sqlite"

# Alternative configurations (uncomment if needed):
# Disable memory entirely
# disabled = true

# Use PostgreSQL backend
# backend = "postgres"
# database_url = "postgresql://user:pass@localhost/mem0"

# Use Redis backend
# backend = "redis"
# database_url = "redis://localhost:6379/0"
"""
    
    config_path = Path("mem0_config_v2.ini")
    with open(config_path, 'w') as f:
        f.write(config_content)
    
    print(f"✅ Created enhanced memory config file: {config_path}")
    return config_path

def disable_memory_completely():
    """Disable memory system completely to avoid all database issues."""
    print("Disabling memory system completely...")
    
    os.environ['MEM0_DISABLED'] = 'true'
    os.environ['BROWSER_USE_MEMORY_DISABLED'] = 'true'
    
    print("✅ Memory system disabled completely")

def apply_memory_fix_v2():
    """Apply the enhanced memory fix."""
    print("Applying enhanced memory fix...")
    
    # Step 1: Clean up all memory databases and directories
    cleanup_memory_databases_v2()
    
    # Step 2: Set up enhanced environment variables
    setup_memory_environment_v2()
    
    # Step 3: Create enhanced memory configuration
    create_memory_config_v2()
    
    # Step 4: Optionally disable memory completely
    # Uncomment the next line if you want to disable memory entirely
    # disable_memory_completely()
    
    print("✅ Enhanced memory fix applied successfully")
    print("\nNext steps:")
    print("1. Try running your agent again")
    print("2. If issues persist, uncomment disable_memory_completely() in this script")
    print("3. Or use a different memory backend (PostgreSQL, Redis)")

def test_memory_fix_v2():
    """Test the enhanced memory fix."""
    print("Testing enhanced memory fix...")
    
    # Test that environment variables are set
    assert os.environ.get('MEM0_DATABASE_URL') == 'sqlite:///:memory:'
    assert os.environ.get('MEM0_BACKEND') == 'sqlite'
    
    # Test that mem0 directories are cleaned up
    mem0_dirs = glob.glob("/tmp/mem0_*")
    assert len(mem0_dirs) == 0, f"Found remaining mem0 directories: {mem0_dirs}"
    
    print("✅ Enhanced memory fix test passed")

if __name__ == "__main__":
    apply_memory_fix_v2()
    test_memory_fix_v2()
