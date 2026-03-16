import fs from 'fs';

const manifestPath = new URL('../samples/benchmark-manifest.json', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const samples = manifest.samples || [];

const summary = {
    totalSamples: samples.length,
    withScale: samples.filter((sample) => sample.scale != null).length,
    withWalls: samples.filter((sample) => Array.isArray(sample.walls) && sample.walls.length > 0).length,
    withRooms: samples.filter((sample) => Array.isArray(sample.rooms) && sample.rooms.length > 0).length,
    withText: samples.filter((sample) => Array.isArray(sample.textElements) && sample.textElements.length > 0).length,
    withDimensions: samples.filter((sample) => Array.isArray(sample.dimensions) && sample.dimensions.length > 0).length,
    withFurniture: samples.filter((sample) => Array.isArray(sample.furniture) && sample.furniture.length > 0).length,
};

console.log(JSON.stringify(summary, null, 2));
