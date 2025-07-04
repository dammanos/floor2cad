FROM python:3.10-slim

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 8080

# >>>> ΝΕΟ: HEALTHCHECK για να βλέπει το Render ότι η app είναι "ζωντανή"
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl --fail http://localhost:8080/ || exit 1

CMD ["uvicorn", "webapp.app:app", "--host", "0.0.0.0", "--port", "8080"]
