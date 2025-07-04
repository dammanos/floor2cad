FROM python:3.10-slim

# Εγκατάσταση Tesseract και βιβλιοθηκών
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Ορισμός working directory
WORKDIR /app
COPY . .

# Εγκατάσταση dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Εκθέτουμε το port 10000 για Render
EXPOSE 10000

# Εκκίνηση FastAPI με Uvicorn
CMD ["uvicorn", "webapp.app:app", "--host", "0.0.0.0", "--port", "10000"]
