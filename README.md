# Floor2CAD - Floor Plan to DXF Converter

A full-stack TypeScript web application that converts floor plans (PNG, JPEG) into DXF files for CAD software.

## Features

- 📤 Drag-and-drop file upload
- 🔍 Deterministic placeholder floor-plan analysis for MVP testing
- 📥 DXF file download
- 🎨 React frontend
- ⚡ Express backend
- 🔧 Shared TypeScript models across client and server

## Tech Stack

- **Frontend**: React 18, TypeScript, CSS3
- **Backend**: Express.js, Node.js, TypeScript
- **Image Processing**: Sharp, Tesseract.js
- **File Format**: DXF (AutoCAD)

## Installation

### Prerequisites
- Node.js 18+ and npm
- Modern web browser

### Setup

1. **Open the project and install**:
```bash
cd /Users/manos.dam/Floor2Cad
npm install
```

2. **Create environment file**:
```bash
cp .env.example .env
```

3. **Start development**:
```bash
npm run dev
```

The app will run on:
- Frontend: http://localhost:3000
- Backend: http://localhost:5001

## Usage

1. Open http://localhost:3000 in your browser
2. Upload a floor plan image (PNG or JPEG)
3. Wait for conversion to complete
4. Download the generated DXF file
5. Open it in your CAD software

## Project Structure

```
src/
├── server/                 # Express backend
│   ├── services/           # Image processing & conversion
│   ├── routes/             # API endpoints
│   └── index.ts            # Server entry point
├── shared/                 # Shared TypeScript types
├── App.tsx                 # Main React component
├── UploadArea.tsx          # Upload UI
├── Preview.tsx             # Conversion summary UI
└── index.tsx               # React entry point
```

## API Endpoints

### `POST /api/upload`
Upload a PNG or JPEG floor plan file.

### `POST /api/convert`
Convert an uploaded file to DXF.

### `GET /api/download/:fileId`
Download a generated DXF file.

### `GET /api/health`
Health check endpoint.

## Build and validation

```bash
npm run build          # Build both server and client
npm run build:server   # Build backend only
npm run build:client   # Build frontend only
npm test               # Build-based validation
```

## Production

```bash
npm run build
npm start
```

The backend serves the React production build from `build/`.

## Current limitations

- PDF uploads are temporarily disabled until rasterization is implemented safely.
- Wall detection is still a deterministic placeholder, not a full CV pipeline.
- OCR and dimensions are scaffolded but not yet integrated into the final output.

## License

MIT
