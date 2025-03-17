#!/usr/bin/env python3
import unittest
import sys
import os
from pathlib import Path
import json
import re

# Add parent directory to path to import task_utils
sys.path.append(str(Path(__file__).parent.parent))
from task_utils import extract_json_from_content

class TestExtractJsonFromContent(unittest.TestCase):
    """Test cases for the extract_json_from_content function with focus on ```json blocks"""

    def test_complete_json_block(self):
        """Test extracting JSON from a complete code block with ```json markers"""
        content = """
        Here is some JSON data:
        ```json
        {
            "name": "John Doe",
            "age": 30,
            "isActive": true
        }
        ```
        """
        result = extract_json_from_content([content])
        self.assertGreaterEqual(len(result), 1)
        # Find the object with the expected data
        found = False
        for obj in result:
            if obj.get("name") == "John Doe" and obj.get("age") == 30 and obj.get("isActive") is True:
                found = True
                break
        self.assertTrue(found, "Expected JSON object not found in results")

    def test_multiple_json_blocks(self):
        """Test extracting multiple JSON objects from code blocks"""
        content = """
        First JSON:
        ```json
        {
            "id": 1,
            "value": "first"
        }
        ```
        
        Second JSON:
        ```json
        {
            "id": 2,
            "value": "second"
        }
        ```
        """
        result = extract_json_from_content([content])
        # Check if both objects are in the results
        ids = [obj.get("id") for obj in result if obj.get("id") in [1, 2]]
        self.assertGreaterEqual(len(ids), 2, "Both JSON objects should be extracted")
        self.assertIn(1, ids)
        self.assertIn(2, ids)

    def test_truncated_json_block(self):
        """Test extracting JSON from a truncated code block"""
        # Simulate a truncated JSON block where the closing ``` is missing
        content = """
        Here is some truncated JSON:
        ```json
        {
            "name": "John Doe",
            "age": 30,
            "address": {
                "street": "123 Main St",
                "city": "Anytown"
            },
            "contacts": [
                {"type": "email", "value": "john@example.com"},
                {"type": "phone"
        """
        
        # Use the extract_json_from_content function instead of manual extraction
        result = extract_json_from_content([content])
        self.assertGreaterEqual(len(result), 1)
        
        # Find the object with the expected data
        found = False
        for obj in result:
            if obj.get("name") == "John Doe" and obj.get("age") == 30:
                # Check if address is present and has the expected city
                if "address" in obj and obj["address"].get("city") == "Anytown":
                    found = True
                    break
        
        self.assertTrue(found, "Expected JSON object not found in results")

    def test_nested_json_block(self):
        """Test extracting nested JSON structures from code blocks"""
        content = """
        ```json
        {
            "person": {
                "name": "John Doe",
                "age": 30,
                "address": {
                    "street": "123 Main St",
                    "city": "Anytown"
                }
            },
            "metadata": {
                "created": "2023-01-01",
                "tags": ["personal", "contact"]
            }
        }
        ```
        """
        result = extract_json_from_content([content])
        self.assertGreaterEqual(len(result), 1)
        
        # Find the complex object in the results
        complex_obj = None
        for obj in result:
            if "person" in obj and "metadata" in obj:
                complex_obj = obj
                break
                
        self.assertIsNotNone(complex_obj, "Complex nested JSON object not found in results")
        if complex_obj:
            # Test nested structure
            self.assertEqual(complex_obj["person"]["name"], "John Doe")
            self.assertEqual(complex_obj["person"]["address"]["city"], "Anytown")
            
            # Test array in metadata
            self.assertEqual(len(complex_obj["metadata"]["tags"]), 2)
            self.assertIn("personal", complex_obj["metadata"]["tags"])

    def test_json_array_block(self):
        """Test extracting JSON arrays from code blocks"""
        content = """
        ```json
        [
            {"id": 1, "name": "Item 1"},
            {"id": 2, "name": "Item 2"},
            {"id": 3, "name": "Item 3"}
        ]
        ```
        """
        result = extract_json_from_content([content])
        self.assertGreaterEqual(len(result), 1)
        
        # Find the array object
        array_obj = None
        for obj in result:
            if isinstance(obj, list) and len(obj) == 3:
                array_obj = obj
                break
                
        self.assertIsNotNone(array_obj, "JSON array not found in results")
        if array_obj:
            self.assertEqual(array_obj[1]["name"], "Item 2")

    def test_truncated_array_block(self):
        """Test extracting a truncated JSON array"""
        # Simulate a truncated JSON array where the closing ``` is missing
        content = """
        Here is a truncated JSON array:
        ```json
        [
            {"id": 1, "name": "Item 1"},
            {"id": 2, "name": "Item 2"},
            {"id": 3
        """
        
        # Use the extract_json_from_content function instead of manual extraction
        result = extract_json_from_content([content])
        self.assertGreaterEqual(len(result), 1)
        
        # Find the array object
        array_obj = None
        for obj in result:
            if isinstance(obj, list):
                array_obj = obj
                break
                
        self.assertIsNotNone(array_obj, "JSON array not found in results")
        if array_obj:
            self.assertEqual(len(array_obj), 2)  # Only 2 complete items
            self.assertEqual(array_obj[0]["id"], 1)
            self.assertEqual(array_obj[0]["name"], "Item 1")
            self.assertEqual(array_obj[1]["id"], 2)
            self.assertEqual(array_obj[1]["name"], "Item 2")

    def test_partial_json_records_array(self):
        """Test extracting JSON with an incomplete array of records"""
        content = """
        ```json
        {
          "records": [
            {
              "Date Recorded": "1973-07-19",
              "Grantor/Grantee": "*Grantor:*\u00a0 STILLPOND",
              "Instrument Type": "PLAT",
              "Book/Page": "Book 1, p. 127",
              "Remarks": "8D DENSITY CALCULATIONS"
            },
            {
              "Date Recorded": "1973-07-19",
              "Grantor/Grantee": "*Grantor:*\u00a0 STILLPOND CONDOMINIUM",
              "Instrument Type": "PLAT",
        """
        
        result = extract_json_from_content([content])
        self.assertGreaterEqual(len(result), 1)
        
        # Find the object with records array
        records_obj = None
        for obj in result:
            if "records" in obj and isinstance(obj["records"], list):
                records_obj = obj
                break
                
        self.assertIsNotNone(records_obj, "JSON object with records array not found in results")
        if records_obj:
            # Should have at least the first complete record
            self.assertGreaterEqual(len(records_obj["records"]), 1)
            
            # Verify the first record's data
            first_record = records_obj["records"][0]
            self.assertEqual(first_record["Date Recorded"], "1973-07-19")
            self.assertEqual(first_record["Grantor/Grantee"], "*Grantor:*\u00a0 STILLPOND")
            self.assertEqual(first_record["Instrument Type"], "PLAT")
            self.assertEqual(first_record["Book/Page"], "Book 1, p. 127")
            self.assertEqual(first_record["Remarks"], "8D DENSITY CALCULATIONS")

    def test_empty_input(self):
        """Test with empty input"""
        result = extract_json_from_content([])
        self.assertEqual(result, [])
        
        result = extract_json_from_content([""])
        self.assertEqual(result, [])
        
        result = extract_json_from_content([None])
        self.assertEqual(result, [])

if __name__ == '__main__':
    unittest.main() 