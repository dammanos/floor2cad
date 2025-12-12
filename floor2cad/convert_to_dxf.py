# File: floor2cad/convert_to_dxf.py
import cv2
import pytesseract
import ezdxf
import numpy as np
import fitz  # PyMuPDF
from PIL import Image
import os

# Ensure tesseract can detect Greek
custom_oem_psm_config = r'--oem 3 --psm 6 -l ell+eng'

# Common Matterport legend/footer text to filter out
MATTERPORT_NOISE_KEYWORDS = [
    'matterport', 'gross', 'floor', 'area', 'living', 'total',
    'sq ft', 'sqft', 'ft²', 'm²', 'bedroom', 'bathroom',
    'interior', 'exterior', 'balcony', 'porch', 'patio'
]

def is_text_noise(text, image_height, y, h, margin_percent=10):
    """Filter out Matterport legend/footer text and text in margins."""
    text_lower = text.lower()
    
    # Filter common Matterport keywords
    for keyword in MATTERPORT_NOISE_KEYWORDS:
        if keyword in text_lower:
            return True
    
    # Filter text in top/bottom margins
    margin_px = image_height * (margin_percent / 100.0)
    text_center_y = y + h / 2
    
    if text_center_y < margin_px or text_center_y > (image_height - margin_px):
        return True
    
    return False

def process_image_and_generate_dxf(image, output_path, scale=1.0, canny1=50, canny2=150, 
                                   min_area=500.0, min_perimeter=300.0, filter_noise=True):
    """Process image and generate DXF with optional text noise filtering."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, canny1, canny2)

    contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    doc = ezdxf.new()
    msp = doc.modelspace()

    height, _ = gray.shape

    for cnt in contours:
        area = cv2.contourArea(cnt)
        perimeter = cv2.arcLength(cnt, True)
        if area > min_area and perimeter > min_perimeter:
            points = cnt[:, 0, :].astype(float)
            points[:, 1] = height - points[:, 1]  # mirror vertically
            points *= scale
            for i in range(len(points)):
                start = points[i]
                end = points[(i + 1) % len(points)]
                msp.add_line(start, end)

    # Extract text with OCR
    data = pytesseract.image_to_data(gray, config=custom_oem_psm_config, output_type=pytesseract.Output.DICT)
    n_boxes = len(data['level'])
    for i in range(n_boxes):
        text = data['text'][i].strip()
        if len(text) > 0:
            (x, y, w, h) = (data['left'][i], data['top'][i], data['width'][i], data['height'][i])
            
            # Apply noise filtering if enabled
            if filter_noise and is_text_noise(text, height, y, h):
                continue
            
            center = (x + w / 2, height - (y + h / 2))
            msp.add_text(text, dxfattribs={"height": 20}).dxf.insert = center

    doc.saveas(output_path)
    print(f"Converted image to DXF: {output_path}")

def generate_pdf_preview(image, output_path):
    """Generate a PDF preview from the processed image."""
    # Convert BGR to RGB for PIL
    if len(image.shape) == 3 and image.shape[2] == 3:
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    else:
        image_rgb = image
    
    pil_image = Image.fromarray(image_rgb)
    pil_image.save(output_path, "PDF", resolution=100.0)
    print(f"Generated PDF preview: {output_path}")

def convert_png_to_dxf(input_path, output_path, scale=1.0, canny1=50, canny2=150, 
                       min_area=500.0, min_perimeter=300.0, filter_noise=True, generate_pdf=False):
    """Convert PNG/JPG/JPEG to DXF."""
    image = cv2.imread(input_path)
    if image is None:
        raise ValueError(f"Failed to load image: {input_path}")
    
    process_image_and_generate_dxf(image, output_path, scale, canny1, canny2, 
                                   min_area, min_perimeter, filter_noise)
    
    if generate_pdf:
        pdf_path = output_path.replace('.dxf', '.pdf')
        generate_pdf_preview(image, pdf_path)
        return pdf_path
    return None

def convert_pdf_to_dxf(input_path, output_path, page_number=0, filter_noise=True, generate_pdf=False):
    """Convert PDF to DXF using PyMuPDF, with page selection."""
    doc = fitz.open(input_path)
    
    if len(doc) == 0:
        doc.close()
        raise ValueError("No pages found in PDF")
    
    if page_number >= len(doc):
        doc.close()
        raise ValueError(f"Page {page_number} not found. PDF has {len(doc)} page(s).")
    
    page = doc[page_number]
    pix = page.get_pixmap(dpi=150)
    
    # Validate pixel format
    if pix.n not in (3, 4):
        doc.close()
        raise ValueError(f"Unsupported pixel format: {pix.n} channels. Expected 3 (RGB) or 4 (RGBA).")
    
    # Convert to numpy array (RGB)
    img_data = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    
    # Convert RGB to BGR for OpenCV
    if pix.n == 4:  # RGBA
        image = cv2.cvtColor(img_data, cv2.COLOR_RGBA2BGR)
    else:  # RGB
        image = cv2.cvtColor(img_data, cv2.COLOR_RGB2BGR)
    
    doc.close()
    
    process_image_and_generate_dxf(image, output_path, filter_noise=filter_noise)
    
    if generate_pdf:
        pdf_path = output_path.replace('.dxf', '.pdf')
        generate_pdf_preview(image, pdf_path)
        return pdf_path
    return None

def convert_tiff_to_dxf(input_path, output_path, page_number=0, filter_noise=True, generate_pdf=False):
    """Convert TIFF to DXF, with multi-page support."""
    try:
        # Open with PIL to handle multi-page TIFF
        pil_image = Image.open(input_path)
        
        # Check if multi-page
        n_frames = getattr(pil_image, 'n_frames', 1)
        
        if page_number >= n_frames:
            raise ValueError(f"Page {page_number} not found. TIFF has {n_frames} page(s).")
        
        # Seek to the desired page (works for both single and multi-page)
        pil_image.seek(page_number)
        
        # Convert to numpy array
        image_rgb = np.array(pil_image.convert('RGB'))
        image = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
        
        pil_image.close()
        
        process_image_and_generate_dxf(image, output_path, filter_noise=filter_noise)
        
        if generate_pdf:
            pdf_path = output_path.replace('.dxf', '.pdf')
            generate_pdf_preview(image, pdf_path)
            return pdf_path
        return None
        
    except Exception as e:
        raise ValueError(f"Failed to process TIFF file: {str(e)}")
