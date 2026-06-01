/*
 * dev-only ASCII face previewer (NOT shipped). Renders a faceSpec's feature cells as a
 * text grid so faces can be eyeballed without a browser. node grid/_ascii.mjs > out.txt
 *
 * Each glyph: '#' feature (D), 'o' highlight/white (W), '*' blush (P), '+' cool/sweat (C).
 * Window is cropped to the face region (rows 13..29, cols 4..25) for legibility.
 */
import { composeFace } from './face.mjs';
import { propCells } from './props.mjs';

const GLYPH = { D: '#', W: 'o', P: '*', C: '+', G: '%', S: '@', B: '.', H: '|' };
const R0 = 13, R1 = 30, C0 = 4, C1 = 26;

function renderFace(name, faceSpec = {}, props = []) {
  const cells = [...composeFace(faceSpec), ...props.flatMap((p) => propCells(p))];
  const rows = [];
  for (let y = R0; y < R1; y++) rows.push(Array(C1 - C0).fill(' '));
  for (const c of cells) {
    if (c.y < R0 || c.y >= R1 || c.x < C0 || c.x >= C1) continue;
    rows[c.y - R0][c.x - C0] = GLYPH[c.c] || '?';
  }
  const spec = Object.entries(faceSpec).map(([k, v]) => `${k}:${v}`).join(' ');
  return `\n── ${name} ──  {${spec}}\n` + rows.map((r) => '  ' + r.join('')).join('\n') + '\n';
}

// edit FACES to preview; passed as argv[2] = JSON array of {name, face, props?}
const arg = process.argv[2];
const FACES = arg ? JSON.parse(arg) : [{ name: 'neutral', face: {} }];
let out = '';
for (const f of FACES) out += renderFace(f.name, f.face, f.props || []);
process.stdout.write(out);
