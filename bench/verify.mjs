// Verifies the fast CFF bbox decoder produces bit-for-bit identical results
// to the original `glyph.path.bbox` for every glyph of every CFF font in the
// repo, including a CFF2 variable font at several variation settings.
import { openSync } from '../dist/node/index.js';

const fonts = [
  'NotoSansCJK/NotoSansCJKkr-Regular.otf',
  'NotoSansCJK/NotoSansCJKjp-Regular-subset.otf',
  'PlayfairDisplay/PlayfairDisplay-Regular.otf',
  'SourceSansPro/SourceSansPro-Regular.otf',
];

let failures = 0;
let checked = 0;

function checkFont(font, label) {
  for (let id = 0; id < font.numGlyphs; id++) {
    const glyph = font.getGlyph(id);
    if (!glyph || glyph.type !== 'CFF') continue;
    let fast, slow;
    let fastErr = null,
      slowErr = null;
    try {
      fast = glyph.bbox; // goes through the fast decoder
    } catch (e) {
      fastErr = e;
    }
    try {
      slow = glyph.path.bbox; // original path-based computation
    } catch (e) {
      slowErr = e;
    }
    checked++;
    if (fastErr || slowErr) {
      if ((fastErr === null) !== (slowErr === null)) {
        failures++;
        console.log(
          `MISMATCH ${label} glyph ${id}: fast ${fastErr ? 'threw' : 'ok'} / slow ${slowErr ? 'threw' : 'ok'}`,
        );
      }
      continue;
    }
    for (const key of ['minX', 'minY', 'maxX', 'maxY']) {
      if (!Object.is(fast[key], slow[key])) {
        failures++;
        console.log(
          `MISMATCH ${label} glyph ${id} ${key}: fast=${fast[key]} slow=${slow[key]}`,
        );
        if (failures > 20) process.exit(1);
      }
    }
  }
}

for (const file of fonts) {
  const font = openSync(new URL(`../test/data/${file}`, import.meta.url));
  checkFont(font, file);
}

// CFF2 variable font, default and several variation settings
const vf = openSync(
  new URL('../test/data/fonttest/AdobeVFPrototype-Subset.otf', import.meta.url),
);
checkFont(vf, 'AdobeVFPrototype default');
for (const settings of [{ wght: 100 }, { wght: 900 }, { wght: 471 }]) {
  checkFont(
    vf.getVariation(settings),
    `AdobeVFPrototype ${JSON.stringify(settings)}`,
  );
}

console.log(`checked ${checked} glyphs, ${failures} mismatches`);
if (failures > 0) process.exit(1);
