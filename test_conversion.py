#!/usr/bin/env python3
"""
Smoke test script for Floor2CAD conversion.
Tests basic conversion functionality for PNG, PDF, and TIFF files.
"""

import os
import sys
import tempfile
from pathlib import Path

# Add floor2cad to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from floor2cad.convert_to_dxf import (
    convert_png_to_dxf,
    convert_pdf_to_dxf,
    convert_tiff_to_dxf
)
import numpy as np
import cv2
from PIL import Image


def create_sample_image(path, width=800, height=600):
    """Create a simple test image with some shapes."""
    # Create a white background
    img = np.ones((height, width, 3), dtype=np.uint8) * 255
    
    # Draw some rectangles (simulating rooms)
    cv2.rectangle(img, (100, 100), (300, 300), (0, 0, 0), 2)
    cv2.rectangle(img, (350, 100), (550, 300), (0, 0, 0), 2)
    cv2.rectangle(img, (100, 350), (300, 550), (0, 0, 0), 2)
    
    # Add some text
    cv2.putText(img, "Kitchen", (150, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    cv2.putText(img, "Bedroom", (380, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    cv2.putText(img, "Bathroom", (130, 450), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    
    # Add some Matterport noise that should be filtered
    cv2.putText(img, "Matterport", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (128, 128, 128), 1)
    cv2.putText(img, "Total Area: 1200 sq ft", (10, height - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (128, 128, 128), 1)
    
    cv2.imwrite(path, img)
    print(f"Created sample image: {path}")
    return img


def create_sample_pdf(path, width=800, height=600):
    """Create a sample PDF with 2 pages."""
    img = create_sample_image(path.replace('.pdf', '_temp.png'), width, height)
    
    # Convert to PIL and save as PDF
    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    pil_img.save(path, "PDF")
    
    # Clean up temp file
    os.remove(path.replace('.pdf', '_temp.png'))
    print(f"Created sample PDF: {path}")


def create_sample_tiff(path, width=800, height=600, num_pages=2):
    """Create a sample multi-page TIFF."""
    images = []
    for i in range(num_pages):
        img = np.ones((height, width, 3), dtype=np.uint8) * 255
        cv2.rectangle(img, (50, 50), (width-50, height-50), (0, 0, 0), 2)
        cv2.putText(img, f"Page {i}", (width//2 - 50, height//2), 
                   cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
        pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        images.append(pil_img)
    
    # Save as multi-page TIFF
    images[0].save(path, save_all=True, append_images=images[1:])
    print(f"Created sample TIFF with {num_pages} pages: {path}")


def test_png_conversion():
    """Test PNG to DXF conversion."""
    print("\n=== Testing PNG Conversion ===")
    with tempfile.TemporaryDirectory() as tmpdir:
        png_path = os.path.join(tmpdir, "test.png")
        dxf_path = os.path.join(tmpdir, "test.dxf")
        
        create_sample_image(png_path)
        convert_png_to_dxf(png_path, dxf_path)
        
        assert os.path.exists(dxf_path), "DXF file was not created"
        assert os.path.getsize(dxf_path) > 0, "DXF file is empty"
        print(f"✓ PNG conversion successful: {os.path.getsize(dxf_path)} bytes")
        return True


def test_png_with_pdf_preview():
    """Test PNG to DXF conversion with PDF preview."""
    print("\n=== Testing PNG Conversion with PDF Preview ===")
    with tempfile.TemporaryDirectory() as tmpdir:
        png_path = os.path.join(tmpdir, "test.png")
        dxf_path = os.path.join(tmpdir, "test.dxf")
        pdf_path = os.path.join(tmpdir, "test.pdf")
        
        create_sample_image(png_path)
        result_pdf = convert_png_to_dxf(png_path, dxf_path, generate_pdf=True)
        
        assert os.path.exists(dxf_path), "DXF file was not created"
        assert result_pdf == pdf_path, "PDF path not returned correctly"
        assert os.path.exists(pdf_path), "PDF preview was not created"
        assert os.path.getsize(pdf_path) > 0, "PDF preview is empty"
        print(f"✓ PNG with PDF preview successful: DXF={os.path.getsize(dxf_path)} bytes, PDF={os.path.getsize(pdf_path)} bytes")
        return True


def test_pdf_conversion():
    """Test PDF to DXF conversion."""
    print("\n=== Testing PDF Conversion ===")
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = os.path.join(tmpdir, "test.pdf")
        dxf_path = os.path.join(tmpdir, "test.dxf")
        
        create_sample_pdf(pdf_path)
        convert_pdf_to_dxf(pdf_path, dxf_path, page_number=0)
        
        assert os.path.exists(dxf_path), "DXF file was not created"
        assert os.path.getsize(dxf_path) > 0, "DXF file is empty"
        print(f"✓ PDF conversion successful: {os.path.getsize(dxf_path)} bytes")
        return True


def test_tiff_conversion():
    """Test TIFF to DXF conversion."""
    print("\n=== Testing TIFF Conversion ===")
    with tempfile.TemporaryDirectory() as tmpdir:
        tiff_path = os.path.join(tmpdir, "test.tiff")
        dxf_path = os.path.join(tmpdir, "test.dxf")
        
        create_sample_tiff(tiff_path, num_pages=2)
        convert_tiff_to_dxf(tiff_path, dxf_path, page_number=0)
        
        assert os.path.exists(dxf_path), "DXF file was not created"
        assert os.path.getsize(dxf_path) > 0, "DXF file is empty"
        print(f"✓ TIFF conversion successful: {os.path.getsize(dxf_path)} bytes")
        return True


def test_tiff_multipage():
    """Test multi-page TIFF conversion with page selection."""
    print("\n=== Testing Multi-page TIFF Conversion ===")
    with tempfile.TemporaryDirectory() as tmpdir:
        tiff_path = os.path.join(tmpdir, "test_multipage.tiff")
        dxf_path1 = os.path.join(tmpdir, "test_page0.dxf")
        dxf_path2 = os.path.join(tmpdir, "test_page1.dxf")
        
        create_sample_tiff(tiff_path, num_pages=2)
        
        # Convert page 0
        convert_tiff_to_dxf(tiff_path, dxf_path1, page_number=0)
        assert os.path.exists(dxf_path1), "Page 0 DXF file was not created"
        
        # Convert page 1
        convert_tiff_to_dxf(tiff_path, dxf_path2, page_number=1)
        assert os.path.exists(dxf_path2), "Page 1 DXF file was not created"
        
        print(f"✓ Multi-page TIFF conversion successful: Page 0={os.path.getsize(dxf_path1)} bytes, Page 1={os.path.getsize(dxf_path2)} bytes")
        return True


def main():
    """Run all tests."""
    print("Floor2CAD Smoke Test Suite")
    print("=" * 50)
    
    tests = [
        test_png_conversion,
        test_png_with_pdf_preview,
        test_pdf_conversion,
        test_tiff_conversion,
        test_tiff_multipage,
    ]
    
    passed = 0
    failed = 0
    
    for test in tests:
        try:
            if test():
                passed += 1
        except Exception as e:
            print(f"✗ {test.__name__} failed: {e}")
            import traceback
            traceback.print_exc()
            failed += 1
    
    print("\n" + "=" * 50)
    print(f"Results: {passed} passed, {failed} failed out of {len(tests)} tests")
    
    if failed == 0:
        print("✓ All tests passed!")
        return 0
    else:
        print("✗ Some tests failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
