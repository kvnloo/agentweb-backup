#!/usr/bin/env python3
import unittest
import sys
import os
from pathlib import Path
from typing import Optional

# Define the validate_content_format function directly in this file
def validate_content_format(extension: str, content: str) -> Optional[str]:
    """Validate that the content matches the expected format for the given extension.
    
    Args:
        extension: File extension (lowercase, without the dot)
        content: Content to validate
        
    Returns:
        Optional[str]: Error message if validation fails, None if validation passes
    """
    try:
        # Skip validation for empty content
        if not content.strip():
            return "Content cannot be empty"
            
        # JSON validation
        if extension == 'json':
            try:
                import json
                json.loads(content)
            except json.JSONDecodeError as e:
                return f"Invalid JSON format: {str(e)}"
                
        # CSV validation
        elif extension == 'csv':
            # Basic CSV validation - check for comma-separated values
            lines = content.strip().split('\n')
            if not lines:
                return "CSV file must have at least one line"
                
            # Check if all rows have the same number of columns
            first_row_cols = lines[0].count(',') + 1
            for i, line in enumerate(lines[1:], 2):
                if line.count(',') + 1 != first_row_cols:
                    return f"CSV format error: Row {i} has a different number of columns than the header row"
                    
        # XML validation
        elif extension == 'xml':
            try:
                import xml.etree.ElementTree as ET
                ET.fromstring(content)
            except Exception as e:
                return f"Invalid XML format: {str(e)}"
                
        # HTML validation (basic check)
        elif extension == 'html' or extension == 'htm':
            if not content.strip().startswith(('<html', '<!DOCTYPE', '<HTML')):
                return "HTML content should start with <!DOCTYPE html> or <html> tag"
                
        # YAML validation
        elif extension == 'yaml' or extension == 'yml':
            try:
                import yaml
                yaml.safe_load(content)
            except Exception as e:
                return f"Invalid YAML format: {str(e)}"
                
        # No specific validation for other formats
        return None
            
    except Exception as e:
        print(f"Error during content validation: {str(e)}")
        return f"Content validation error: {str(e)}"

class TestValidateContentFormat(unittest.TestCase):
    """Test cases for the validate_content_format function"""

    def test_empty_content(self):
        """Test validation of empty content"""
        self.assertEqual(validate_content_format('txt', ''), "Content cannot be empty")
        self.assertEqual(validate_content_format('txt', '   '), "Content cannot be empty")
        self.assertEqual(validate_content_format('txt', '\n\n'), "Content cannot be empty")

    def test_json_validation(self):
        """Test validation of JSON content"""
        # Valid JSON
        self.assertIsNone(validate_content_format('json', '{"name": "John", "age": 30}'))
        self.assertIsNone(validate_content_format('json', '[1, 2, 3]'))
        
        # Invalid JSON
        self.assertIsNotNone(validate_content_format('json', '{name: "John", age: 30}'))
        self.assertIsNotNone(validate_content_format('json', '[1, 2, 3'))
        self.assertIsNotNone(validate_content_format('json', '{"name": "John", "age": }'))

    def test_csv_validation(self):
        """Test validation of CSV content"""
        # Valid CSV
        self.assertIsNone(validate_content_format('csv', 'name,age,city\nJohn,30,New York\nJane,25,Boston'))
        self.assertIsNone(validate_content_format('csv', 'a,b,c\n1,2,3\n4,5,6'))
        
        # Invalid CSV (inconsistent columns)
        self.assertIsNotNone(validate_content_format('csv', 'name,age,city\nJohn,30\nJane,25,Boston'))
        self.assertIsNotNone(validate_content_format('csv', 'a,b,c\n1,2,3\n4,5,6,7'))

    def test_xml_validation(self):
        """Test validation of XML content"""
        # Valid XML
        self.assertIsNone(validate_content_format('xml', '<root><item>1</item><item>2</item></root>'))
        self.assertIsNone(validate_content_format('xml', '<?xml version="1.0"?><data><entry>test</entry></data>'))
        
        # Invalid XML
        self.assertIsNotNone(validate_content_format('xml', '<root><item>1</item><item>2</item>'))
        self.assertIsNotNone(validate_content_format('xml', '<root><item>1</item></wrongtag>'))

    def test_html_validation(self):
        """Test validation of HTML content"""
        # Valid HTML
        self.assertIsNone(validate_content_format('html', '<!DOCTYPE html><html><body>Hello</body></html>'))
        self.assertIsNone(validate_content_format('html', '<html><head><title>Test</title></head><body>Content</body></html>'))
        
        # Invalid HTML (missing doctype or html tag)
        self.assertIsNotNone(validate_content_format('html', '<body>Hello</body>'))
        self.assertIsNotNone(validate_content_format('html', 'This is not HTML'))

    def test_yaml_validation(self):
        """Test validation of YAML content"""
        # Valid YAML
        self.assertIsNone(validate_content_format('yaml', 'name: John\nage: 30\ncity: New York'))
        self.assertIsNone(validate_content_format('yaml', '- item1\n- item2\n- item3'))
        
        # Invalid YAML
        self.assertIsNotNone(validate_content_format('yaml', 'name: John\nage: : 30\ncity: New York'))
        self.assertIsNotNone(validate_content_format('yaml', '- item1: : value\n- item2'))

    def test_other_formats(self):
        """Test validation of other formats (no specific validation)"""
        # Other formats should pass without specific validation
        self.assertIsNone(validate_content_format('txt', 'This is a text file'))
        self.assertIsNone(validate_content_format('md', '# Markdown Heading\n\nContent'))
        self.assertIsNone(validate_content_format('py', 'def hello():\n    print("Hello, world!")'))

if __name__ == '__main__':
    unittest.main() 