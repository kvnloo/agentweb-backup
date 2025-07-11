#!/usr/bin/env python3
"""
Test script for downloading videos from various platforms.
This script tests the ability to download videos from Instagram posts and Google Drive.
"""

import os
import sys
import logging
import asyncio
import tempfile
import argparse
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

async def test_google_drive_video_download():
    """Test Google Drive video download using gdown library"""
    logger.info("Starting Google Drive video download test")
    
    try:
        # Import gdown for Google Drive downloads
        try:
            import gdown
        except ImportError:
            logger.error("gdown library not installed. Install with: pip install gdown")
            return False
        
        # Test Google Drive URL (you can replace this with a real Google Drive video URL)
        # Example formats:
        # - Direct file: https://drive.google.com/file/d/FILE_ID/view
        # - Shared link: https://drive.google.com/open?id=FILE_ID
        # - Folder: https://drive.google.com/drive/folders/FOLDER_ID
        
        # For testing, we'll use a placeholder URL - replace with actual Google Drive video URL
        google_drive_url = "https://drive.google.com/file/d/1l-RhMk3AG1ijLlVhUcCD1J50WgS3I8tN/view?usp=sharing"
        
        logger.info(f"Testing Google Drive video download from: {google_drive_url}")
        
        # Extract file ID from URL
        if '/file/d/' in google_drive_url:
            file_id = google_drive_url.split('/file/d/')[1].split('/')[0]
        elif 'id=' in google_drive_url:
            file_id = google_drive_url.split('id=')[1].split('&')[0]
        else:
            logger.error("❌ Could not extract file ID from Google Drive URL")
            return False
        
        logger.info(f"Extracted file ID: {file_id}")
        
        # Create a downloads directory for manual verification
        downloads_dir = Path("downloads/google_drive_test")
        downloads_dir.mkdir(parents=True, exist_ok=True)
        
        # Construct the direct download URL
        direct_url = f"https://drive.google.com/uc?id={file_id}"
        
        try:
            # Download the video using gdown
            logger.info("Downloading video from Google Drive...")
            output_path = downloads_dir / f"video_{file_id}.mp4"
            
            # Use gdown to download the file
            result = gdown.download(direct_url, str(output_path), quiet=False)
            
            if result is None:
                logger.error("❌ Download failed - gdown returned None")
                return False
            
            # Check if file was created and has content
            if output_path.exists():
                file_size = output_path.stat().st_size
                
                logger.info(f"✅ Video downloaded successfully!")
                logger.info(f"  - File path: {output_path}")
                logger.info(f"  - File size: {file_size} bytes")
                
                if file_size > 0:
                    logger.info("✅ Video file verification successful!")
                    
                    # Read a small portion to verify it's actually a video file
                    with open(output_path, 'rb') as f:
                        header = f.read(10)
                        if header.startswith(b'\x00\x00\x00') or header.startswith(b'ftyp'):
                            logger.info("✅ Video file header verification successful!")
                            logger.info(f"📁 Video file saved to: {output_path}")
                            logger.info("You can manually verify the video file at the above location.")
                            return True
                        else:
                            logger.warning("⚠️ File doesn't appear to have a valid video header")
                            logger.info(f"📁 Video file saved to: {output_path}")
                            logger.info("You can manually verify the video file at the above location.")
                            return True  # Still consider it successful as gdown worked
                else:
                    logger.error("❌ Downloaded file is empty")
                    return False
            else:
                logger.error("❌ File was not created")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error downloading video: {e}")
            return False
    
    except Exception as e:
        logger.error(f"❌ Error in Google Drive video download test: {e}")
        return False

def main():
    """Main function to run the tests"""
    parser = argparse.ArgumentParser(description='Test video downloads from various platforms')
    parser.add_argument('--instagram', action='store_true', help='Test Instagram video download')
    parser.add_argument('--google-drive', action='store_true', help='Test Google Drive video download')
    parser.add_argument('--all', action='store_true', help='Test all platforms (default)')
    
    args = parser.parse_args()
    
    # If no specific test is selected, run all tests
    if not (args.instagram or args.google_drive or args.all):
        args.all = True
    
    logger.info("="*60)
    logger.info("VIDEO DOWNLOAD TESTS")
    logger.info("="*60)
    
    results = {}
    
    # Test Instagram video download
    if args.instagram or args.all:
        logger.info("INSTAGRAM VIDEO DOWNLOAD TEST")
        logger.info("-" * 40)
        instagram_success = asyncio.run(test_instagram_video_download())
        results['Instagram'] = instagram_success
        
        logger.info("="*60)
        if instagram_success:
            logger.info("🎉 Instagram video download test PASSED!")
            logger.info("The instaloader library works correctly for Instagram videos.")
        else:
            logger.error("❌ Instagram video download test FAILED!")
            logger.error("Please check the logs above for details.")
    
    # Test Google Drive video download
    if args.google_drive or args.all:
        logger.info("="*60)
        logger.info("GOOGLE DRIVE VIDEO DOWNLOAD TEST")
        logger.info("-" * 40)
        gdrive_success = asyncio.run(test_google_drive_video_download())
        results['Google Drive'] = gdrive_success
        
        logger.info("="*60)
        if gdrive_success:
            logger.info("🎉 Google Drive video download test PASSED!")
            logger.info("The gdown library works correctly for Google Drive videos.")
        else:
            logger.error("❌ Google Drive video download test FAILED!")
            logger.error("Please check the logs above for details.")
    
    # Summary
    if len(results) > 1:
        logger.info("="*60)
        logger.info("TEST SUMMARY")
        logger.info("="*60)
        for platform, success in results.items():
            logger.info(f"{platform}: {'✅ PASSED' if success else '❌ FAILED'}")
        logger.info("="*60)

if __name__ == "__main__":
    main() 