import fs from 'node:fs';
import { openSync } from '../dist/node/index.js';

// Draws glyphs 1 and 20000 of Noto Sans CJK KR with their bounding boxes.
// The boxes are the same numbers the bbox walk sums over: glyph.bbox.
const font = openSync(
  new URL(
    '../test/data/NotoSansCJK/NotoSansCJKkr-Regular.otf',
    import.meta.url,
  ),
);

// The same walk as bench/bbox.mjs: one bbox per glyph, maxX summed.
let sum = 0;
const walked = new Map();
for (let id = 1; id <= 20000; id++) {
  const box = font.getGlyph(id).bbox;
  walked.set(id, box);
  sum += box.maxX;
}
console.log(`walk sum over glyphs 1..20000: ${sum}`);

const ids = [1, 20000];
const parts = [];
let offsetX = 0;
let minY = Infinity;
let maxY = -Infinity;
for (const id of ids) {
  const glyph = font.getGlyph(id);
  const box = glyph.bbox;
  const walkedBox = walked.get(id);
  for (const key of ['minX', 'minY', 'maxX', 'maxY']) {
    if (!Object.is(box[key], walkedBox[key])) {
      throw new Error(
        `glyph ${id} ${key}: preview ${box[key]} != walk ${walkedBox[key]}`,
      );
    }
  }
  console.log(
    `glyph ${id} edges: minX=${box.minX} minY=${box.minY} maxX=${box.maxX} maxY=${box.maxY}`,
  );

  const d = glyph.path.toSVG();
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  parts.push(`
  <g transform="translate(${offsetX - box.minX},0)">
    <rect x="${box.minX}" y="${-box.maxY}" width="${w}" height="${h}" fill="none" stroke="#e0453a" stroke-width="4"/>
    <path d="${d}" transform="scale(1,-1)" fill="#f4f1ea"/>
  </g>`);
  offsetX += w + 200;
  minY = Math.min(minY, box.minY);
  maxY = Math.max(maxY, box.maxY);
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-maxY} ${offsetX} ${maxY - minY}" width="960">
  <rect x="0" y="${-maxY}" width="${offsetX}" height="${maxY - minY}" fill="#111"/>
  ${parts.join('')}
</svg>
`;
fs.writeFileSync(new URL('./out.svg', import.meta.url), svg);
console.log('wrote preview/out.svg');
