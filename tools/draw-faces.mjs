/*
 * animayte · face art — the shared FACIAL FEATURE LIBRARY (§4.3), palette-parameterised.
 *
 * Eyes/mouth/brows/accents carry ~90% of the emotion and are independent of the body, so
 * ANY pet reuses the exact same expression craft — `makeFaceLib(P)` closes the drawing
 * over a pet's palette. The slime and the bean call this with their own ramps; that reuse
 * is the whole bet of the engine (the library re-skins onto any design). Each function is
 * drawn in the spirit of the matching Apple emoji.
 */

export const inEll = (x, y, cx, cy, rx, ry) => { const dx = (x - cx) / rx, dy = (y - cy) / ry; return dx * dx + dy * dy <= 1; };
export const fillEll = (C, cx, cy, rx, ry, col) => { for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) if (inEll(x, y, cx, cy, rx, ry)) C.px(x, y, col); };

/**
 * makeFaceLib(P) → { drawEyes, drawBrows, drawMouth, drawAccents } drawn in palette P.
 * P needs: pup, white, star, cheek, flush, sweat, mouth, tongue.
 */
export function makeFaceLib(P) {
  function drawEyes(C, type, exL, exR, ey, blink) {
    if (blink && (type === 'dots' || type === 'open' || type === 'look_up')) type = 'closed';
    const eye = (ex) => {
      switch (type) {
        case 'dots':                                   // 🙂 simple calm eyes
          fillEll(C, ex, ey, 1.6, 2.4, P.pup); break;
        case 'open':                                   // 😟/😅 round open eyes
          fillEll(C, ex, ey, 2.4, 3.0, P.white);
          fillEll(C, ex, ey + 0.5, 1.7, 2.1, P.pup);
          C.px(ex + 1, ey - 1, P.white); break;
        case 'look_up':                                // 🤔 glancing up
          fillEll(C, ex, ey, 2.2, 2.8, P.white);
          fillEll(C, ex, ey - 1, 1.5, 1.7, P.pup); break;
        case 'wide':                                   // 😳 wide, startled/flushed eyes
          fillEll(C, ex, ey, 2.8, 3.3, P.white);
          fillEll(C, ex, ey, 1.4, 1.6, P.pup);
          C.px(ex + 1, ey - 1, P.white); break;
        case 'happy_arc':                              // 😄 smiling (∧) eyes
          for (let x = -3; x <= 3; x++) { const y = ey - Math.round((1 - Math.abs(x) / 3) * 2); C.px(ex + x, y, P.pup); C.px(ex + x, y + 1, P.pup); } break;
        case 'closed':                                 // 😴 / blink — gentle ‿ line
          for (let x = -3; x <= 3; x++) { const y = ey + Math.round((1 - (x / 3) ** 2) * 1.2); C.px(ex + x, y, P.pup); } break;
        case 'stars':                                  // 🤩 star-struck
          for (let i = -3; i <= 3; i++) { C.px(ex + i, ey, P.star); C.px(ex, ey + i, P.star); }
          C.px(ex - 1, ey - 1, P.star); C.px(ex + 1, ey - 1, P.star); C.px(ex - 1, ey + 1, P.star); C.px(ex + 1, ey + 1, P.star);
          C.px(ex, ey, P.white); break;
      }
    };
    eye(exL); eye(exR);
  }

  function drawBrows(C, type, exL, exR, ey) {
    if (!type) return;
    const brow = (ex, mirror) => {
      switch (type) {
        case 'one_raised':                             // 🤔 — only the right brow lifts
          if (mirror) { for (let x = -2; x <= 2; x++) C.px(ex + x, ey - 6, P.pup); }
          else { for (let x = -2; x <= 2; x++) C.px(ex + x, ey - 4, P.pup); }
          break;
        case 'worried':                                // 😅 — both lift, slightly arched
          for (let x = -2; x <= 2; x++) C.px(ex + x, ey - 5 - (x === 0 ? 1 : 0), P.pup); break;
        case 'sad': {                                  // 😟 — inner ends angle up  \   /
          for (let i = 0; i < 4; i++) { const x = mirror ? i : -i; C.px(ex + x, ey - 5 + i, P.pup); }
          break;
        }
      }
    };
    brow(exL, false); brow(exR, true);
  }

  function drawMouth(C, type, cx, my) {
    switch (type) {
      case 'slight_smile':                             // 🙂 gentle upturn
        for (let x = -3; x <= 3; x++) C.px(cx + x, my + Math.round((1 - (x / 3) ** 2) * 1.4), P.mouth); break;
      case 'open_smile':                               // 😄 open happy mouth
        for (let y = 0; y <= 3; y++) for (let x = -4; x <= 4; x++) if ((x / 4) ** 2 + ((y - 1.4) / 2.4) ** 2 <= 1 && y >= 0) C.px(cx + x, my + y, y >= 2 ? P.tongue : P.mouth); break;
      case 'big_grin':                                 // 🤩 wide grin with teeth
        for (let y = -1; y <= 3; y++) for (let x = -5; x <= 5; x++) if ((x / 5) ** 2 + ((y - 1) / 2.6) ** 2 <= 1) C.px(cx + x, my + y, P.mouth);
        for (let x = -4; x <= 4; x++) C.px(cx + x, my - 1, P.white); break;
      case 'flat_skew':                                // 🤔 flat line pushed to one side
        for (let x = -1; x <= 4; x++) C.px(cx + x, my + 1, P.mouth); break;
      case 'awkward':                                  // 😅 small wavy open
        for (let x = -3; x <= 3; x++) C.px(cx + x, my + (x % 2 ? 1 : 0), P.mouth);
        C.px(cx - 1, my + 1, P.mouth); C.px(cx, my + 2, P.tongue); C.px(cx + 1, my + 1, P.mouth); break;
      case 'frown':                                    // 😟 downturned
        for (let x = -3; x <= 3; x++) C.px(cx + x, my + 2 - Math.round((1 - (x / 3) ** 2) * 1.6), P.mouth); break;
      case 'small':                                    // 😴 tiny mouth
        C.px(cx - 1, my, P.mouth); C.px(cx, my, P.mouth); C.px(cx + 1, my, P.mouth); C.px(cx, my + 1, P.mouth); break;
    }
  }

  function drawAccents(C, face, cx, cy, eyeY, RX) {
    if (face.blush) { for (let y = -2; y <= 1; y++) for (let x = -3; x <= 3; x++) if ((x / 3) ** 2 + (y / 1.6) ** 2 <= 1) { C.px(cx - 15 + x, eyeY + 4 + y, [...P.cheek, 235]); C.px(cx + 15 + x, eyeY + 4 + y, [...P.cheek, 235]); } }
    if (face.flush) {  // 😳 deep, large blush spanning the cheeks + warm tint — embarrassment
      for (let y = -3; y <= 2; y++) for (let x = -4; x <= 4; x++) if ((x / 4) ** 2 + (y / 2.4) ** 2 <= 1) { C.px(cx - 14 + x, eyeY + 4 + y, [...P.flush, 235]); C.px(cx + 14 + x, eyeY + 4 + y, [...P.flush, 235]); }
      C.px(cx - 9, eyeY + 2, [...P.flush, 150]); C.px(cx + 9, eyeY + 2, [...P.flush, 150]);
    }
    if (face.sweat) { const sx = cx + 16, sy = eyeY - 6; C.px(sx, sy, P.sweat); C.px(sx, sy + 1, P.sweat); C.px(sx - 1, sy + 2, P.sweat); C.px(sx + 1, sy + 2, P.sweat); C.px(sx, sy + 3, P.sweat); C.px(sx, sy, [255, 255, 255, 200]); }
    if (face.zzz) { const zx = cx + 12, zy = eyeY - 9; C.px(zx, zy, P.pup); C.px(zx + 1, zy, P.pup); C.px(zx + 2, zy, P.pup); C.px(zx + 1, zy + 1, P.pup); C.px(zx, zy + 2, P.pup); C.px(zx + 1, zy + 2, P.pup); C.px(zx + 2, zy + 2, P.pup); C.px(zx + 4, zy - 3, P.pup); C.px(zx + 5, zy - 3, P.pup); C.px(zx + 5, zy - 2, P.pup); C.px(zx + 4, zy - 1, P.pup); C.px(zx + 5, zy - 1, P.pup); }
  }

  return { drawEyes, drawBrows, drawMouth, drawAccents };
}
