const { PNG } = require('pngjs');
const { FONT_5X7 } = require('./font5x7');

// Renders one or more lines of text into a PNG buffer using the 5x7 bitmap font.
// Returns { buffer, width, height } — a dark card background with cream/amber text,
// matching the Servision brand.
function renderTextToPNG(lines, options = {}) {
  const scale = options.scale || 6;       // pixel size of each font "dot"
  const charSpacing = 1;                  // gap between characters (in font-dots)
  const lineSpacing = 2;                  // gap between lines (in font-dots)
  const padding = 3;                      // outer padding (in font-dots)

  const upperLines = lines.map(l => l.toUpperCase());

  const maxCharsInLine = Math.max(...upperLines.map(l => l.length));
  const dotsWide = padding * 2 + maxCharsInLine * (5 + charSpacing) - charSpacing;
  const dotsHigh = padding * 2 + upperLines.length * (7 + lineSpacing) - lineSpacing;

  const width = dotsWide * scale;
  const height = dotsHigh * scale;

  const png = new PNG({ width, height });

  // Background: dark card matching Servision's brand (#1A1812) at full opacity,
  // with a subtle amber border baked in
  const bg = { r: 0x1A, g: 0x18, b: 0x12, a: 255 };
  const border = { r: 0xC8, g: 0x87, b: 0x3A, a: 255 };
  const text = { r: 0xF2, g: 0xED, b: 0xE4, a: 255 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const isBorder = x < scale || x >= width - scale || y < scale || y >= height - scale;
      const c = isBorder ? border : bg;
      png.data[idx] = c.r;
      png.data[idx + 1] = c.g;
      png.data[idx + 2] = c.b;
      png.data[idx + 3] = c.a;
    }
  }

  function setPixel(px, py, color) {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const idx = (width * py + px) << 2;
    png.data[idx] = color.r;
    png.data[idx + 1] = color.g;
    png.data[idx + 2] = color.b;
    png.data[idx + 3] = color.a;
  }

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
          const baseY = (lineDotY + row) * scale;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              setPixel(baseX + sx, baseY + sy, text);
            }
          }
        }
      }
      dotX += 5 + charSpacing;
    }
  });

  const buffer = PNG.sync.write(png);
  return { buffer, width, height };
}

module.exports = { renderTextToPNG };
