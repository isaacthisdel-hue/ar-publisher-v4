const { PNG } = require('pngjs');
const { FONT_5X7 } = require('./font5x7');

// Renders the nutrition card PNG: an optional row of 5 spice peppers at the top
// (red = filled to the spice level, grey = empty), then the text lines below.
// Returns { buffer, width, height }. Dark card, amber border, cream text —
// matching the Servision brand.
function renderTextToPNG(lines, options = {}) {
  const scale = options.scale || 6;
  const charSpacing = 1;
  const lineSpacing = 2;
  const padding = 3;

  const spiceLevel = Math.max(0, Math.min(5, parseInt(options.spiceLevel, 10) || 0));
  const hasSpice = spiceLevel > 0;

  const upperLines = lines.map(l => l.toUpperCase());

  // Width is driven by the longest text line, but never less than the pepper row needs
  const maxCharsInLine = upperLines.length ? Math.max(...upperLines.map(l => l.length)) : 0;
  const textDotsWide = padding * 2 + Math.max(1, maxCharsInLine) * (5 + charSpacing) - charSpacing;

  // Pepper row sizing (in pixels, added on top of the text block)
  const pepperH = hasSpice ? Math.round(scale * 8) : 0;   // height of the pepper row
  const pepperGap = hasSpice ? Math.round(scale * 2) : 0; // gap under the peppers

  const width = textDotsWide * scale;
  const textBlockHeight = (padding * 2 + upperLines.length * (7 + lineSpacing) - lineSpacing) * scale;
  const height = pepperH + pepperGap + textBlockHeight;

  const png = new PNG({ width, height });

  const bg = { r: 0x1A, g: 0x18, b: 0x12, a: 255 };
  const border = { r: 0xC8, g: 0x87, b: 0x3A, a: 255 };
  const text = { r: 0xF2, g: 0xED, b: 0xE4, a: 255 };
  const pepperRed = { r: 0xD9, g: 0x3A, b: 0x2B, a: 255 };   // filled pepper
  const pepperGrey = { r: 0x55, g: 0x50, b: 0x48, a: 255 };  // empty pepper
  const stemGreen = { r: 0x6A, g: 0x8F, b: 0x3C, a: 255 };   // little stem

  // Fill background + amber border
  const borderPx = scale;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const isBorder = x < borderPx || x >= width - borderPx || y < borderPx || y >= height - borderPx;
      const c = isBorder ? border : bg;
      png.data[idx] = c.r; png.data[idx+1] = c.g; png.data[idx+2] = c.b; png.data[idx+3] = c.a;
    }
  }

  function setPixel(px, py, color) {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const idx = (width * py + px) << 2;
    png.data[idx] = color.r; png.data[idx+1] = color.g; png.data[idx+2] = color.b; png.data[idx+3] = color.a;
  }

  // Draw a single pepper (a rounded body tapering to a point, plus a stem) into
  // a box at (bx, by) of size (bw, bh). filled=true -> red, else grey.
  function drawPepper(bx, by, bw, bh, filled) {
    const body = filled ? pepperRed : pepperGrey;
    const cx = bx + bw / 2;
    // Body: a vertical teardrop. Width tapers from top (wide) to bottom (point).
    const bodyTop = by + Math.round(bh * 0.28);
    const bodyBot = by + bh;
    const bodyH = bodyBot - bodyTop;
    for (let y = bodyTop; y < bodyBot; y++) {
      const t = (y - bodyTop) / bodyH;               // 0 at top, 1 at bottom
      const halfW = (bw * 0.42) * (1 - t * 0.85);     // taper to a point
      const curve = Math.sin(t * Math.PI) * bw * 0.06; // slight curve
      for (let x = Math.round(cx - halfW + curve); x <= Math.round(cx + halfW + curve); x++) {
        setPixel(x, y, body);
      }
    }
    // Stem at the top
    const stemTop = by + Math.round(bh * 0.10);
    for (let y = stemTop; y < bodyTop + 1; y++) {
      for (let x = Math.round(cx - bw*0.06); x <= Math.round(cx + bw*0.06); x++) {
        setPixel(x, y, stemGreen);
      }
    }
    // Little stem tip bending right
    for (let x = Math.round(cx); x <= Math.round(cx + bw*0.16); x++) {
      setPixel(x, stemTop, stemGreen);
      setPixel(x, stemTop+1, stemGreen);
    }
  }

  // Draw the pepper row (5 peppers, centered)
  if (hasSpice) {
    const count = 5;
    const rowPad = borderPx + scale;
    const avail = width - rowPad * 2;
    const cell = avail / count;
    const pW = Math.min(cell * 0.8, pepperH * 0.7);
    const pH = pepperH * 0.82;
    for (let i = 0; i < count; i++) {
      const cellX = rowPad + i * cell + (cell - pW) / 2;
      const cellY = borderPx + Math.round(scale * 0.5);
      drawPepper(cellX, cellY, pW, pH, i < spiceLevel);
    }
  }

  // Draw text lines below the pepper row
  const textStartY = pepperH + pepperGap;
  upperLines.forEach((line, lineIdx) => {
    const lineDotY = padding + lineIdx * (7 + lineSpacing);
    let dotX = padding;
    for (const ch of line) {
      const glyph = FONT_5X7[ch] || FONT_5X7[' '];
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col++) {
          const on = (bits >> (4 - col)) & 1;
          if (!on) continue;
          const baseX = (dotX + col) * scale;
          const baseY = textStartY + (lineDotY + row) * scale;
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              setPixel(baseX + sx, baseY + sy, text);
        }
      }
      dotX += 5 + charSpacing;
    }
  });

  const buffer = PNG.sync.write(png);
  return { buffer, width, height };
}

module.exports = { renderTextToPNG };
