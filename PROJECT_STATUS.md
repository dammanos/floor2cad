# Floor2CAD - Status and Delivery Strategy

## What has been completed

### MVP workflow
- Built an end-to-end upload → convert → download flow.
- Added a React frontend for file upload, progress, preview, and DXF download.
- Added an Express backend for upload, conversion, health checks, and download delivery.
- Centralized shared floor plan models in [src/shared/types.ts](src/shared/types.ts).

### Conversion pipeline
- Added `ImageProcessor` for image loading, resizing, grayscale conversion, OCR, and metadata reads.
- Added `FloorPlanConverter` to orchestrate detection and DXF generation.
- Added `DXFGenerator` to export walls, openings, furniture, dimensions, and text into DXF.
- Replaced random wall output with a deterministic placeholder heuristic so repeated conversions are stable.

### Hardening completed in this review
- Fixed backend build scripts to use [tsconfig.server.json](tsconfig.server.json).
- Split client and server TypeScript configuration so React and Node settings no longer conflict.
- Fixed static asset serving to use the React production build folder.
- Added explicit environment loading with `dotenv`.
- Tightened upload validation with file-size limits and clearer error messages.
- Restricted uploads to PNG/JPEG until PDF rasterization is implemented safely.
- Added file ID validation and download existence checks.
- Removed the duplicate unused frontend under [src/client](src/client).
- Cleaned conflicting documentation and startup guidance.

## Strategy followed

### 1. Make the system usable early
The initial strategy was to deliver a working vertical slice first:
1. upload a plan
2. convert it into structured floor-plan data
3. generate a DXF
4. return a downloadable result

This gave the project a testable MVP quickly.

### 2. Keep responsibilities modular
The backend was separated into focused services:
- image processing
- wall detection
- conversion orchestration
- DXF generation

This keeps future algorithm upgrades isolated.

### 3. Share contracts across frontend and backend
Shared interfaces were used so both sides talk in the same domain model.
That reduced duplication and made the UI integration simpler.

### 4. Stabilize before adding more features
This review focused on correctness and maintainability before expanding detection features:
- remove duplicate code paths
- fix build/runtime mismatches
- improve typing
- validate inputs more strictly
- align documentation with actual behavior

## Current state

The project is now in a cleaner MVP state:
- one active frontend code path
- one correct server build path
- safer uploads and downloads
- clearer docs
- deterministic placeholder conversion output

## Recommended next steps

1. Add real PDF rasterization support before re-enabling PDF uploads.
2. Replace the placeholder wall heuristic with actual computer-vision line extraction.
3. Integrate OCR output and dimension parsing into the final `FloorPlan` model.
4. Add automated API smoke tests for upload, convert, and download.
5. Add cleanup/retention rules for `uploads/` and `outputs/`.

## Accuracy-focused planning

For the next major milestone, see [ACCURACY_ROADMAP.md](ACCURACY_ROADMAP.md).
That plan focuses on:
- edge + contour based wall extraction
- structured OCR text detection
- dimension and scale inference
- room semantics
- furniture detection
- Matterport-like structured output