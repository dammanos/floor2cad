import os
from datetime import datetime
from fastapi import FastAPI, File, UploadFile, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from floor2cad.convert_to_dxf import convert_png_to_dxf, convert_pdf_to_dxf

app = FastAPI()

# Ensure folders exist
os.makedirs("webapp/uploads", exist_ok=True)
os.makedirs("outputs", exist_ok=True)

# Static & templates
app.mount("/static", StaticFiles(directory="webapp/static"), name="static")
templates = Jinja2Templates(directory="webapp/templates")

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "error": None,
        "demo_used": False
    })

@app.post("/convert")
async def convert_file(request: Request, file: UploadFile = File(...)):
    try:
        ext = file.filename.split(".")[-1].lower()
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_name = file.filename.replace(" ", "_")
        filename = f"{timestamp}_{safe_name}"

        upload_path = os.path.join("webapp/uploads", filename)
        with open(upload_path, "wb") as buffer:
            buffer.write(await file.read())

        output_filename = os.path.splitext(filename)[0] + ".dxf"
        output_path = os.path.join("outputs", output_filename)

        if ext in ["png", "jpg", "jpeg"]:
            convert_png_to_dxf(upload_path, output_path)
        elif ext == "pdf":
            convert_pdf_to_dxf(upload_path, output_path)
        else:
            raise ValueError("Unsupported file type")

        return FileResponse(output_path, filename=output_filename, media_type="application/dxf")

    except Exception as e:
        return templates.TemplateResponse("index.html", {
            "request": request,
            "error": str(e),
            "demo_used": False
        })
