#!/usr/bin/env python3
"""
Test file for is_page_broken function in task_utils.py
"""

import unittest
from unittest.mock import patch, Mock, MagicMock
import sys
import os

# Add the parent directory to the path so we can import task_utils
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import task_utils directly - no need to mock browser_use for these tests
# as is_page_broken only uses requests module
from task_utils import is_page_broken

class TestIsPageBroken(unittest.TestCase):
    """Test cases for is_page_broken function"""
    
    def setUp(self):
        """Set up test fixtures"""
        self.test_url = "https://example.com/test.html"
        self.available_urls = [
            "https://example.com/image1.png",
            "https://example.com/chart.jpg",
            "https://example.com/data.csv"
        ]
    
    @patch('task_utils.requests.get')
    def test_has_relative_images_simple(self, mock_get):
        """Test detection of simple relative image paths"""
        # Mock HTML content with relative images
        html_content = '''
        <html>
        <body>
            <img src="image.png" alt="test">
            <img src="chart.jpg" alt="chart">
        </body>
        </html>
        '''
        
        # Mock the response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        # Test the function
        result = is_page_broken(self.test_url)
        
        # Assertions
        self.assertTrue(result)
        mock_get.assert_called_once_with(self.test_url, timeout=30)
    
    @patch('task_utils.requests.get')
    def test_has_relative_images_with_paths(self, mock_get):
        """Test detection of relative images with various path formats"""
        html_content = '''
        <html>
        <body>
            <img src="./images/logo.png" alt="logo">
            <img src="/assets/chart.svg" alt="chart">
            <img src="data/icons/icon.ico" alt="icon">
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertTrue(result)
    
    @patch('task_utils.requests.get')
    def test_no_relative_images_absolute_urls(self, mock_get):
        """Test that absolute URLs are not detected as relative"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/image.png" alt="test">
            <img src="http://example.com/chart.jpg" alt="chart">
            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==" alt="data">
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertFalse(result)
    
    @patch('task_utils.requests.get')
    def test_no_images_at_all(self, mock_get):
        """Test HTML with no images"""
        html_content = '''
        <html>
        <body>
            <h1>No images here</h1>
            <p>Just text content</p>
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertFalse(result)
    
    @patch('task_utils.requests.get')
    def test_mixed_absolute_and_relative(self, mock_get):
        """Test HTML with both absolute and relative images"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/absolute.png" alt="absolute">
            <img src="relative.png" alt="relative">
            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==" alt="data">
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertTrue(result)
    
    @patch('task_utils.requests.get')
    def test_different_image_formats(self, mock_get):
        """Test detection of various image formats"""
        html_content = '''
        <html>
        <body>
            <img src="image.png" alt="png">
            <img src="photo.jpg" alt="jpg">
            <img src="picture.jpeg" alt="jpeg">
            <img src="icon.gif" alt="gif">
            <img src="logo.svg" alt="svg">
            <img src="banner.webp" alt="webp">
            <img src="favicon.ico" alt="ico">
            <img src="image.bmp" alt="bmp">
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertTrue(result)
    
    @patch('task_utils.requests.get')
    def test_case_insensitive(self, mock_get):
        """Test that detection is case insensitive"""
        html_content = '''
        <html>
        <body>
            <img src="IMAGE.PNG" alt="uppercase">
            <img src="Photo.JPG" alt="mixed case">
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertTrue(result)
    
    @patch('task_utils.requests.get')
    def test_http_error(self, mock_get):
        """Test handling of HTTP errors"""
        mock_response = Mock()
        mock_response.status_code = 404
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertTrue(result)  # Should be considered broken if we can't fetch it
    
    @patch('task_utils.requests.get')
    def test_request_exception(self, mock_get):
        """Test handling of request exceptions"""
        mock_get.side_effect = Exception("Network error")
        
        result = is_page_broken(self.test_url)
        
        self.assertTrue(result)  # Should be considered broken if we can't check it
    
    @patch('task_utils.requests.get')
    def test_timeout_parameter(self, mock_get):
        """Test that timeout parameter is passed correctly"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = '<html><body><img src="test.png"></body></html>'
        mock_get.return_value = mock_response
        
        is_page_broken(self.test_url, timeout=60)
        
        mock_get.assert_called_once_with(self.test_url, timeout=60)
    
    @patch('task_utils.requests.get')
    def test_single_quotes(self, mock_get):
        """Test detection with single quotes"""
        html_content = '''
        <html>
        <body>
            <img src='image.png' alt='test'>
            <img src='./chart.jpg' alt='chart'>
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url)
        
        self.assertTrue(result)
    
    @patch('task_utils.requests.get')
    def test_unreferenced_available_urls(self, mock_get):
        """Test detection of unreferenced available URLs"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/image1.png" alt="available">
            <img src="https://example.com/extra.png" alt="extra">
            <a href="https://example.com/data.csv">Available data</a>
            <a href="https://example.com/extra.csv">Extra data</a>
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        # Add an extra URL that's not referenced in HTML
        available_urls_with_extra = self.available_urls + ["https://example.com/unreferenced.png"]
        
        result = is_page_broken(self.test_url, available_urls_with_extra)
        
        self.assertTrue(result)  # Should be broken because chart.jpg is not referenced
    
    @patch('task_utils.requests.get')
    def test_all_available_urls_referenced(self, mock_get):
        """Test when all available URLs are referenced"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/image1.png" alt="available">
            <img src="https://example.com/chart.jpg" alt="available">
            <a href="https://example.com/data.csv">Available data</a>
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url, self.available_urls)
        
        self.assertFalse(result)
    
    @patch('task_utils.requests.get')
    def test_extra_referenced_urls_are_ok(self, mock_get):
        """Test that extra referenced URLs (not in available_urls) are OK"""
        html_content = '''
        <html>
        <body>
            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==" alt="data">
            <img src="https://example.com/image1.png" alt="available">
            <img src="https://example.com/chart.jpg" alt="available">
            <a href="https://example.com/data.csv">Available data</a>
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url, self.available_urls)
        
        self.assertFalse(result)  # All available URLs are referenced, extra URLs are OK
    
    @patch('task_utils.requests.get')
    def test_extra_special_urls_are_ok(self, mock_get):
        """Test that extra special URLs (not in available_urls) are OK"""
        html_content = '''
        <html>
        <body>
            <a href="mailto:test@example.com">Email</a>
            <a href="tel:+1234567890">Phone</a>
            <a href="javascript:void(0)">JS Link</a>
            <img src="https://example.com/image1.png" alt="available">
            <img src="https://example.com/chart.jpg" alt="available">
            <a href="https://example.com/data.csv">Available data</a>
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url, self.available_urls)
        
        self.assertFalse(result)  # All available URLs are referenced, extra special URLs are OK
    
    @patch('task_utils.requests.get')
    def test_no_result_urls_provided(self, mock_get):
        """Test behavior when no result_urls are provided"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/image1.png" alt="test">
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url, None)
        
        self.assertFalse(result)  # Should only check for relative images
    
    @patch('task_utils.requests.get')
    def test_empty_result_urls(self, mock_get):
        """Test behavior when empty result_urls list is provided"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/image1.png" alt="test">
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url, [])
        
        self.assertFalse(result)  # Should only check for relative images
    
    @patch('task_utils.requests.get')
    def test_self_reference_in_available_urls(self, mock_get):
        """Test that self-reference is OK when included in available_urls"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/test.html" alt="self reference">
            <img src="https://example.com/image1.png" alt="available">
            <img src="https://example.com/chart.jpg" alt="available">
            <a href="https://example.com/data.csv">Available data</a>
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        # Include the file_url in available_urls
        available_urls_with_self = self.available_urls + [self.test_url]
        
        result = is_page_broken(self.test_url, available_urls_with_self)
        
        self.assertFalse(result)  # Should not be broken because all available URLs are referenced
    
    @patch('task_utils.requests.get')
    def test_missing_available_url_from_html(self, mock_get):
        """Test that missing available URL from HTML is considered broken"""
        html_content = '''
        <html>
        <body>
            <img src="https://example.com/image1.png" alt="available">
            <img src="https://example.com/chart.jpg" alt="available">
            <!-- data.csv is missing from HTML -->
        </body>
        </html>
        '''
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = html_content
        mock_get.return_value = mock_response
        
        result = is_page_broken(self.test_url, self.available_urls)
        
        self.assertTrue(result)  # Should be broken because data.csv is not referenced in HTML

if __name__ == '__main__':
    unittest.main()
