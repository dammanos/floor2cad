# Benchmark Dataset Template

Use this folder to build a real validation set for Floor2CAD.

## Recommended structure

- original image or rasterized plan
- optional cleaned reference image
- annotation JSON
- notes about expected scale/unit

Example:

- `sample-001.png`
- `sample-001.annotation.json`
- `sample-001.notes.md`

## Annotation goals

Each sample should ideally contain:
- walls
- openings
- room polygons
- text labels
- dimensions
- furniture symbols
- real-world unit/scale if known

## Suggested annotation schema

```json
{
  "id": "sample-001",
  "image": "sample-001.png",
  "unit": "m",
  "scale": 0.02,
  "walls": [],
  "openings": [],
  "rooms": [],
  "textElements": [],
  "dimensions": [],
  "furniture": []
}
```

## Metrics to track

- wall precision / recall
- average wall endpoint error
- opening precision / recall
- OCR accuracy
- room polygon IoU
- dimension value accuracy
- furniture classification accuracy

## Initial target

Create at least:
- 10 clean plans
- 10 medium-noise plans
- 10 difficult plans

This will make tuning meaningful instead of guessing.
