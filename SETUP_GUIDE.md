# Floor2CAD - Setup Guide

## Current status

- Cleaned up and ready for local testing
- Single active frontend in `src/`
- Backend and frontend builds aligned
- Upload validation tightened for PNG/JPEG files

## Quick Start

### 1. Navigate to project
```bash
cd /Users/manos.dam/Floor2Cad
```

### 2. Start development
```bash
npm run dev
```

The app runs on:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:5001/api

### 3. Use the application
1. Open http://localhost:3000
2. Upload a PNG or JPEG floor plan
3. Wait for conversion
4. Download the DXF file

## Project Structure

```
Floor2Cad/
├── src/
│   ├── server/                          # Express backend
│   ├── shared/                          # Shared TypeScript models
│   ├── App.tsx                          # Main React component
│   ├── UploadArea.tsx                   # Upload component
│   ├── Preview.tsx                      # Result summary component
│   └── index.tsx                        # React entry point
├── public/                              # HTML template
├── build/                               # React production output
├── package.json                         # Scripts and dependencies
├── tsconfig.json                        # Frontend TypeScript config
├── tsconfig.server.json                 # Backend TypeScript config
├── .env.example                         # Example environment values
└── PROJECT_STATUS.md                    # Delivery status and strategy
```

## Main Commands

```bash
npm run dev          # Start backend and frontend
npm run server:dev   # Start backend only
npm run client:dev   # Start frontend only
npm run build        # Build backend and frontend
npm test             # Build-based validation
npm start            # Run built backend
```

## Supported Files

**Input**
- PNG (.png)
- JPEG (.jpg, .jpeg)

**Output**
- DXF (.dxf)

PDF uploads are currently disabled until rasterization is added safely.

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```
PORT=5001
UPLOAD_DIR=./uploads
OUTPUT_DIR=./outputs
MAX_FILE_SIZE=50000000
```

## Troubleshooting

### Port already in use
```bash
lsof -i :5001 | grep -v COMMAND | awk '{print $2}' | xargs kill -9
```

### Rebuild production assets
```bash
npm run build
npm start
```

## Next recommended improvements

1. Add safe PDF rasterization support.
2. Replace the placeholder wall heuristic with real CV detection.
3. Integrate OCR and dimensions into the returned `FloorPlan` data.
4. Add automated API smoke tests.
