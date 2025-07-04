# Βάση image με Python
FROM python:3.10-slim

# Εγκατάσταση εξαρτήσεων συστήματος και Tesseract OCR
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Ορισμός directory εργασίας
WORKDIR /app

# Αντιγραφή όλων των αρχείων
COPY . .

# Εγκατάσταση εξαρτήσεων Python
RUN pip install --no-cache-dir -r requirements.txt

# Άνοιγμα της πόρτας 10000 για Render
EXPOSE 10000

# Εκκίνηση FastAPI app μέσω uvicorn (προσαρμοσμένο path)
CMD ["uvicorn", "webapp.app:app", "--host", "0.0.0.0", "--port", "10000"]
