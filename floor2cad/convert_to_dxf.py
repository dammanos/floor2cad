# File: floor2cad/convert_to_dxf.py
import cv2
import pytesseract
import ezdxf
import numpy as np
from pdf2image import convert_from_path
import tempfile

# Ensure tesseract can detect Greek
custom_oem_psm_config = r'--oem 3 --psm 6 -l ell+eng'

def process_image_and_generate_dxf(image, output_path, scale=1.0, canny1=50, canny2=150, min_area=500.0, min_perimeter=300.0):
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

    data = pytesseract.image_to_data(gray, config=custom_oem_psm_config, output_type=pytesseract.Output.DICT)
    n_boxes = len(data['level'])
    for i in range(n_boxes):
        text = data['text'][i].strip()
        if len(text) > 0:
            (x, y, w, h) = (data['left'][i], data['top'][i], data['width'][i], data['height'][i])
            center = (x + w / 2, height - (y + h / 2))
            msp.add_text(text, dxfattribs={"height": 20}).dxf.insert = center

    doc.saveas(output_path)
    print(f"Converted image to DXF: {output_path}")

def convert_png_to_dxf(input_path, output_path, scale=1.0, canny1=50, canny2=150, min_area=500.0, min_perimeter=300.0):
    image = cv2.imread(input_path)
    process_image_and_generate_dxf(image, output_path, scale, canny1, canny2, min_area, min_perimeter)

def convert_pdf_to_dxf(input_path, output_path):
    with tempfile.TemporaryDirectory() as path:
        images = convert_from_path(input_path, output_folder=path, fmt="png")
        if not images:
            raise ValueError("No pages found in PDF")
        image = np.array(images[0])[:, :, :3]  # use only RGB if alpha present
        process_image_and_generate_dxf(image, output_path)
