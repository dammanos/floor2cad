import fs from 'fs';

const baseUrl = process.env.FLOOR2CAD_BASE_URL || 'http://localhost:5001';
const tempImagePath = '/tmp/floor2cad-smoke.png';
const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKkQAAAAASUVORK5CYII=';

const writeSmokeImage = () => {
    fs.writeFileSync(tempImagePath, Buffer.from(base64Png, 'base64'));
};

const cleanup = (fileId) => {
    try {
        fs.unlinkSync(tempImagePath);
    } catch {
        // Ignore cleanup errors.
    }

    if (!fileId) {
        return;
    }

    for (const filePath of [`uploads/${fileId}.png`, `outputs/${fileId}.dxf`]) {
        try {
            fs.unlinkSync(filePath);
        } catch {
            // Ignore cleanup errors.
        }
    }
};

const main = async () => {
    writeSmokeImage();
    let fileId;

    try {
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(tempImagePath)], { type: 'image/png' }), 'smoke.png');

        const uploadResponse = await fetch(`${baseUrl}/api/upload`, {
            method: 'POST',
            body: form,
        });
        const upload = await uploadResponse.json();
        console.log(JSON.stringify({ step: 'upload', status: uploadResponse.status, data: upload }));
        if (!upload.success) {
            throw new Error(upload.error || 'Upload failed');
        }

        fileId = upload.fileId;
        const convertResponse = await fetch(`${baseUrl}/api/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId }),
        });
        const convert = await convertResponse.json();
        console.log(JSON.stringify({
            step: 'convert',
            status: convertResponse.status,
            success: convert.success,
            walls: convert.data?.walls?.length,
            openings: convert.data?.openings?.length,
            texts: convert.data?.textElements?.length,
            dimensions: convert.data?.dimensions?.length,
            rooms: convert.data?.rooms?.length,
            unit: convert.data?.unit,
            scale: convert.data?.scale,
        }));
        if (!convert.success) {
            throw new Error(convert.error || 'Conversion failed');
        }

        const downloadResponse = await fetch(`${baseUrl}/api/download/${fileId}`);
        const downloadText = await downloadResponse.text();
        console.log(JSON.stringify({
            step: 'download',
            status: downloadResponse.status,
            contentType: downloadResponse.headers.get('content-type'),
            prefix: downloadText.slice(0, 20),
        }));

        if (downloadResponse.status !== 200) {
            throw new Error('Download failed');
        }
    } finally {
        cleanup(fileId);
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
