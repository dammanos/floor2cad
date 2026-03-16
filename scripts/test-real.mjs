import fs from 'fs';

const fileId = process.argv[2] || 'cff3ff62-f621-4c95-b426-6a82d3e46284';
const baseUrl = 'http://localhost:5001';

async function test() {
  const resp = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId })
  });
  const data = await resp.json();
  const d = data.data;
  console.log('Success:', data.success);
  console.log('Walls:', d.walls?.length);
  console.log('Openings:', d.openings?.length);
  console.log('Rooms:', d.rooms?.length);
  console.log('Texts:', d.textElements?.length);
  console.log('Dimensions:', d.dimensions?.length);
  console.log('Furniture:', d.furniture?.length);
  console.log('Scale:', d.scale, 'Unit:', d.unit);
  console.log('DXF file:', d.dxfPath);
  if (d.dxfPath) {
    const dxf = fs.readFileSync(d.dxfPath, 'utf-8');
    console.log('DXF size:', dxf.length, 'bytes');
    console.log('Has WALLS layer:', dxf.includes('WALLS'));
    const lineCount = (dxf.match(/\n0\nLINE\n/g) || []).length;
    const polyCount = (dxf.match(/\n0\nLWPOLYLINE\n/g) || []).length;
    const textCount = (dxf.match(/\n0\nTEXT\n/g) || []).length;
    console.log('LINE entities:', lineCount);
    console.log('LWPOLYLINE entities:', polyCount);
    console.log('TEXT entities:', textCount);
  }
}

test().catch(e => console.error(e));
