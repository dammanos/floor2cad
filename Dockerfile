FROM python:3.10-slim

# Εγκατάσταση απαραίτητων εργαλείων και Tesseract
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Δημιουργία directory και αντιγραφή αρχείων
WORKDIR /app
COPY . .

# Εγκατάσταση εξαρτήσεων
RUN pip install --no-cache-dir -r requirements.txt

# Εκθέτει το port για Render
EXPOSE 10000

# Εκκίνηση εφαρμογής
CMD ["uvicorn", "webapp.app:app", "--host", "0.0.0.0", "--port", "10000"]
