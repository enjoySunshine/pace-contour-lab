import { openSync } from '../dist/node/index.js';

const FONT = new URL(
  '../test/data/NotoSansCJK/NotoSansCJKkr-Regular.otf',
  import.meta.url,
);
const FIRST = 1;
const LAST = 20000;

const tOpen0 = performance.now();
const font = openSync(FONT);
const tOpen1 = performance.now();
console.log(`open: ${(tOpen1 - tOpen0).toFixed(1)} ms (not counted)`);

function walk() {
  let sum = 0;
  for (let id = FIRST; id <= LAST; id++) {
    sum += font.getGlyph(id).bbox.maxX;
  }
  return sum;
}

const edges = (id) => {
  const b = font.getGlyph(id).bbox;
  return [b.minX, b.minY, b.maxX, b.maxY].join(',');
};

const t0 = performance.now();
const sum1 = walk();
const t1 = performance.now();
const edgesFirst1 = edges(1);
const edgesFirst20000 = edges(20000);

const t2 = performance.now();
const sum2 = walk();
const t3 = performance.now();
const edgesSecond1 = edges(1);
const edgesSecond20000 = edges(20000);

console.log(`pass 1: ${(t1 - t0).toFixed(1)} ms  sum=${sum1}`);
console.log(`pass 2: ${(t3 - t2).toFixed(1)} ms  sum=${sum2}`);
console.log(`glyph 1     edges pass1: ${edgesFirst1}  pass2: ${edgesSecond1}`);
console.log(
  `glyph 20000 edges pass1: ${edgesFirst20000}  pass2: ${edgesSecond20000}`,
);

if (sum1 !== sum2) throw new Error('sum mismatch between passes');
if (edgesFirst1 !== edgesSecond1)
  throw new Error('glyph 1 edges changed between passes');
if (edgesFirst20000 !== edgesSecond20000)
  throw new Error('glyph 20000 edges changed between passes');
