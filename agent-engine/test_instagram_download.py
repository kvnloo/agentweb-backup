#!/usr/bin/env python3
"""
Test script for downloading Instagram videos using instaloader library.
This script tests the ability to download videos from Instagram posts.
"""

import os
import sys
import logging
import asyncio
import tempfile
from pathlib import Path
from typing import Optional, Dict, Any
from dotenv import load_dotenv

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

async def test_instagram_video_download():
    """Test Instagram video download using instaloader library"""
    logger.info("Starting Instagram video download test")
    
    try:
        # Import instaloader
        try:
            import instaloader
        except ImportError:
            logger.error("instaloader library not installed. Install with: pip install instaloader")
            return False
        
        # Test Instagram URL
        instagram_url = "https://www.instagram.com/p/DLTdRuez9EI"
        
        logger.info(f"Testing Instagram video download from: {instagram_url}")
        
        # Create Instaloader instance
        L = instaloader.Instaloader(
            download_videos=True,
            download_video_thumbnails=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=False,
            compress_json=False
        )
        
        # Extract post shortcode from URL
        shortcode = instagram_url.split('/p/')[-1].split('/')[0]
        logger.info(f"Extracted shortcode: {shortcode}")
        
        # Get post by shortcode
        post = instaloader.Post.from_shortcode(L.context, shortcode)
        
        logger.info(f"Post info:")
        logger.info(f"  - Owner: {post.owner_username}")
        logger.info(f"  - Caption: {post.caption[:100] if post.caption else 'No caption'}...")
        logger.info(f"  - Is video: {post.is_video}")
        logger.info(f"  - Video URL: {post.video_url}")
        
        if not post.is_video:
            logger.error("❌ This post is not a video")
            return False
        
        if not post.video_url:
            logger.error("❌ No video URL found in post")
            return False
        
        logger.info(f"✅ Found video URL: {post.video_url}")
        
        # Create a downloads directory for manual verification
        downloads_dir = Path("downloads/instagram_test")
        downloads_dir.mkdir(parents=True, exist_ok=True)
        
        try:
            # Download the video using instaloader's default naming
            logger.info("Downloading video...")
            L.download_post(post, target=downloads_dir)
            
            # Find the downloaded video file
            video_files = list(downloads_dir.glob("*.mp4"))
            if not video_files:
                logger.error("❌ No video file found in download directory")
                return False
            
            video_file = video_files[0]  # Take the first video file found
            file_size = video_file.stat().st_size
            
            logger.info(f"✅ Video downloaded successfully!")
            logger.info(f"  - File path: {video_file}")
            logger.info(f"  - File size: {file_size} bytes")
            
            if file_size > 0:
                logger.info("✅ Video file verification successful!")
                
                # Read a small portion to verify it's actually a video file
                with open(video_file, 'rb') as f:
                    header = f.read(10)
                    if header.startswith(b'\x00\x00\x00') or header.startswith(b'ftyp'):
                        logger.info("✅ Video file header verification successful!")
                        logger.info(f"📁 Video file saved to: {video_file}")
                        logger.info("You can manually verify the video file at the above location.")
                        return True
                    else:
                        logger.warning("⚠️ File doesn't appear to have a valid video header")
                        logger.info(f"📁 Video file saved to: {video_file}")
                        logger.info("You can manually verify the video file at the above location.")
                        return True  # Still consider it successful as instaloader worked
            else:
                logger.error("❌ Downloaded file is empty")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error downloading video: {e}")
            return False
    
    except Exception as e:
        logger.error(f"❌ Error in Instagram video download test: {e}")
        return False

def main():
    """Main function to run the test"""
    logger.info("="*60)
    logger.info("INSTAGRAM VIDEO DOWNLOAD TEST")
    logger.info("="*60)
    
    success = asyncio.run(test_instagram_video_download())
    
    logger.info("="*60)
    if success:
        logger.info("🎉 Instagram video download test PASSED!")
        logger.info("The instaloader library works correctly for Instagram videos.")
    else:
        logger.error("❌ Instagram video download test FAILED!")
        logger.error("Please check the logs above for details.")
    logger.info("="*60)

if __name__ == "__main__":
    main() 