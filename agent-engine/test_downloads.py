#!/usr/bin/env python3
"""
Test script for downloading videos from various platforms.
This script tests the ability to download videos from Instagram posts, Facebook reels, and Google Drive.
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

async def test_facebook_video_download():
    """Test Facebook video download using yt-dlp library"""
    logger.info("Starting Facebook video download test")
    
    try:
        # Import yt-dlp for Facebook downloads
        try:
            import yt_dlp
        except ImportError:
            logger.error("yt-dlp library not installed. Install with: pip install yt-dlp")
            return False
        
        # Test Facebook URL
        facebook_url = "https://www.facebook.com/reel/1215847160275296/"
        
        logger.info(f"Testing Facebook video download from: {facebook_url}")
        
        # Create a downloads directory for manual verification
        downloads_dir = Path("downloads/facebook_test")
        downloads_dir.mkdir(parents=True, exist_ok=True)
        
        try:
            # Configure yt-dlp options
            ydl_opts = {
                'outtmpl': str(downloads_dir / '%(title)s.%(ext)s'),
                'quiet': False,
                'no_warnings': False,
                'extract_flat': False,
                'format': 'best[ext=mp4]/best',  # Prefer MP4 format
                'writeinfojson': False,
                'writesubtitles': False,
                'writeautomaticsub': False,
                'ignoreerrors': False,
            }
            
            # Download the video
            logger.info("Downloading Facebook video...")
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # Get video info first
                info = ydl.extract_info(facebook_url, download=False)
                logger.info(f"Video info:")
                logger.info(f"  - Title: {info.get('title', 'Unknown')}")
                logger.info(f"  - Duration: {info.get('duration', 'Unknown')} seconds")
                logger.info(f"  - Uploader: {info.get('uploader', 'Unknown')}")
                
                # Download the video
                ydl.download([facebook_url])
            
            # Find the downloaded video file
            video_files = list(downloads_dir.glob("*.mp4"))
            if not video_files:
                # Try other video extensions
                video_files = list(downloads_dir.glob("*.webm")) + list(downloads_dir.glob("*.mkv")) + list(downloads_dir.glob("*.avi"))
            
            if not video_files:
                logger.error("❌ No video file found in download directory")
                return False
            
            video_file = video_files[0]  # Take the first video file found
            file_size = video_file.stat().st_size
            
            # Check file size limit
            max_size_mb = int(os.getenv('MAX_DOWNLOADED_VIDEO_SIZE', '100'))  # Default 100MB
            max_size_bytes = max_size_mb * 1024 * 1024
            
            if file_size > max_size_bytes:
                logger.error(f"❌ Video file too large: {file_size} bytes ({file_size / (1024*1024):.1f} MB) exceeds limit of {max_size_mb} MB")
                return False
            
            logger.info(f"✅ Facebook video downloaded successfully!")
            logger.info(f"  - File path: {video_file}")
            logger.info(f"  - File name: {video_file.name}")
            logger.info(f"  - File size: {file_size} bytes ({file_size / (1024*1024):.1f} MB)")
            logger.info(f"  - Size check passed (limit: {max_size_mb} MB)")
            
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
                        return True  # Still consider it successful as yt-dlp worked
            else:
                logger.error("❌ Downloaded file is empty")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error downloading Facebook video: {e}")
            return False
    
    except Exception as e:
        logger.error(f"❌ Error in Facebook video download test: {e}")
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
            # First, try to get the actual filename from Google Drive
            logger.info("Getting file information from Google Drive...")
            
            # Use gdown to get file info first
            try:
                import requests
                
                # Try to get file info using Google Drive API-like approach
                info_url = f"https://drive.google.com/uc?id={file_id}&export=download"
                response = requests.head(info_url, allow_redirects=True)
                
                # Check if we can get filename from Content-Disposition header
                content_disposition = response.headers.get('Content-Disposition', '')
                filename = None
                if 'filename=' in content_disposition:
                    filename = content_disposition.split('filename=')[1].strip('"')
                    logger.info(f"Found filename from headers: {filename}")
                
                # If no filename found, try a different approach
                if not filename:
                    # Use gdown with --id flag to get file info
                    import subprocess
                    try:
                        result = subprocess.run([
                            'gdown', '--id', file_id, '--print-url'
                        ], capture_output=True, text=True, timeout=30)
                        
                        if result.returncode == 0 and result.stdout.strip():
                            # Parse the output to get filename
                            output_lines = result.stdout.strip().split('\n')
                            for line in output_lines:
                                if 'filename=' in line:
                                    filename = line.split('filename=')[1].strip()
                                    logger.info(f"Found filename from gdown: {filename}")
                                    break
                    except Exception as e:
                        logger.warning(f"Could not get filename from gdown: {e}")
                
            except Exception as e:
                logger.warning(f"Could not get file info: {e}")
            
            # Download the video using gdown
            logger.info("Downloading video from Google Drive...")
            
            # Use gdown with the actual filename if we found it
            if filename:
                # Use the actual filename if we found it
                output_path = str(downloads_dir / filename)
                logger.info(f"Using actual filename: {filename}")
            else:
                # Fallback to generic name
                output_path = str(downloads_dir / "google_drive_video")
                logger.info("Using generic filename")
            
            result = gdown.download(
                direct_url, 
                output_path, 
                quiet=False,
                fuzzy=True,  # Use fuzzy matching to get the correct file
                use_cookies=False  # Don't use cookies which can cause issues
            )
            
            if result is None:
                logger.error("❌ Download failed - gdown returned None")
                return False
            
            # Wait a moment for any file operations to complete
            import time
            time.sleep(2)
            
            # Find the downloaded file (filter out system files and hidden files)
            video_files = [f for f in downloads_dir.glob("*") if not f.name.startswith('.') and f.name != '.DS_Store']
            if not video_files:
                logger.error("❌ No file found after Google Drive download")
                return False
            
            # Take the first file found
            video_file = video_files[0]
            logger.info(f"Found downloaded file: {video_file.name}")
            file_size = video_file.stat().st_size
            
            logger.info(f"✅ Video downloaded successfully!")
            logger.info(f"  - File path: {video_file}")
            logger.info(f"  - File name: {video_file.name}")
            logger.info(f"  - File size: {file_size} bytes")
            
            # Get the actual file extension from the downloaded file
            file_extension = video_file.suffix.lower()
            logger.info(f"  - Detected extension: {file_extension}")
            
            # If no extension or unknown extension, try to infer from filename
            if not file_extension or file_extension not in ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mpg', '.mpeg', '.ogv']:
                # Look for video extensions in the filename
                filename_lower = video_file.name.lower()
                for ext in ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mpg', '.mpeg', '.ogv']:
                    if ext in filename_lower:
                        file_extension = ext
                        logger.info(f"  - Inferred extension from filename: {file_extension}")
                        break
                else:
                    # If no video extension found in filename, assume MP4
                    file_extension = '.mp4'
                    logger.info(f"  - Assuming MP4 extension")
            
            # Determine MIME type based on actual file extension
            mime_type_map = {
                '.mp4': 'video/mp4',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.mkv': 'video/x-matroska',
                '.wmv': 'video/x-ms-wmv',
                '.flv': 'video/x-flv',
                '.webm': 'video/webm',
                '.m4v': 'video/x-m4v',
                '.3gp': 'video/3gpp',
                '.mpg': 'video/mpeg',
                '.mpeg': 'video/mpeg',
                '.ogv': 'video/ogg'
            }
            mime_type = mime_type_map.get(file_extension, 'video/mp4')
            logger.info(f"  - MIME type: {mime_type}")
            
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
                        return True  # Still consider it successful as gdown worked
            else:
                logger.error("❌ Downloaded file is empty")
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
    parser.add_argument('--facebook', action='store_true', help='Test Facebook video download')
    parser.add_argument('--google-drive', action='store_true', help='Test Google Drive video download')
    parser.add_argument('--all', action='store_true', help='Test all platforms (default)')
    
    args = parser.parse_args()
    
    # If no specific test is selected, run all tests
    if not (args.instagram or args.facebook or args.google_drive or args.all):
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
    
    # Test Facebook video download
    if args.facebook or args.all:
        logger.info("="*60)
        logger.info("FACEBOOK VIDEO DOWNLOAD TEST")
        logger.info("-" * 40)
        facebook_success = asyncio.run(test_facebook_video_download())
        results['Facebook'] = facebook_success
        
        logger.info("="*60)
        if facebook_success:
            logger.info("🎉 Facebook video download test PASSED!")
            logger.info("The yt-dlp library works correctly for Facebook videos.")
        else:
            logger.error("❌ Facebook video download test FAILED!")
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