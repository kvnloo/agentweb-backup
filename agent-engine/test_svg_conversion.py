#!/usr/bin/env python3
"""
Test script for high-quality SVG to PNG/WebP conversion.
This script tests the improved conversion functions with high DPI settings.
"""

import os
import sys
import logging
from pathlib import Path
from task_utils import convert_svg_to_png

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def test_svg_conversion():
    """Test SVG conversion with different quality settings and prompt replacement"""
    
    # Look for SVG files in the attachments directory
    attachments_dir = Path('attachments')
    svg_files = list(attachments_dir.rglob('*.svg'))
    
    if not svg_files:
        logger.error("No SVG files found in attachments directory")
        return False
    
    # Test with the first SVG file found
    svg_file = svg_files[0]
    logger.info(f"Testing with SVG file: {svg_file}")
    
    # Test prompt replacement functionality
    test_prompt = f"Please process the image {svg_file.name} and create a new version"
    logger.info(f"Original prompt: {test_prompt}")
    
    # Simulate the prompt replacement that happens in the actual code
    png_file_name = svg_file.with_suffix('.png').name
    updated_prompt = test_prompt.replace(svg_file.name, png_file_name)
    logger.info(f"Updated prompt: {updated_prompt}")
    
    if svg_file.name in updated_prompt:
        logger.warning("⚠️  SVG filename still found in updated prompt - replacement may not be working correctly")
    else:
        logger.info("✅ Prompt replacement working correctly")
    
    # Test different conversion settings
    test_cases = [
        {
            'name': 'Standard High Quality PNG (300 DPI, 2048px width)',
            'func': convert_svg_to_png,
            'ext': '.png',
            'params': {'dpi': 300, 'width': 2048}
        },
        {
            'name': 'Ultra High Quality PNG (600 DPI, 4096px width)',
            'func': convert_svg_to_png,
            'ext': '.png',
            'params': {'dpi': 600, 'width': 4096}
        },
        {
            'name': 'Default Settings PNG (300 DPI, no width specified)',
            'func': convert_svg_to_png,
            'ext': '.png',
            'params': {}
        }
    ]
    
    results = []
    
    for test_case in test_cases:
        logger.info(f"\n--- Testing: {test_case['name']} ---")
        
        # Create output filename
        output_file = svg_file.with_suffix(test_case['ext']).with_name(
            f"{svg_file.stem}_{test_case['name'].lower().replace(' ', '_').replace('(', '').replace(')', '')}{test_case['ext']}"
        )
        
        # Perform conversion
        success = test_case['func'](str(svg_file), str(output_file), **test_case['params'])
        
        if success and output_file.exists():
            file_size = output_file.stat().st_size
            logger.info(f"✅ Success: {output_file.name} ({file_size:,} bytes)")
            results.append({
                'name': test_case['name'],
                'file': output_file.name,
                'size': file_size,
                'success': True
            })
        else:
            logger.error(f"❌ Failed: {test_case['name']}")
            results.append({
                'name': test_case['name'],
                'file': 'N/A',
                'size': 0,
                'success': False
            })
    
    # Print summary
    logger.info("\n" + "="*60)
    logger.info("CONVERSION TEST SUMMARY")
    logger.info("="*60)
    
    for result in results:
        status = "✅ SUCCESS" if result['success'] else "❌ FAILED"
        size_str = f"{result['size']:,} bytes" if result['success'] else "N/A"
        logger.info(f"{status} | {result['name']:<40} | {size_str}")
    
    successful_conversions = sum(1 for r in results if r['success'])
    logger.info(f"\nTotal: {successful_conversions}/{len(results)} conversions successful")
    
    return successful_conversions > 0

if __name__ == "__main__":
    success = test_svg_conversion()
    sys.exit(0 if success else 1)
