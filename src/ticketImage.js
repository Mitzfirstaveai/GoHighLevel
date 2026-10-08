// The downloadable ticket image: the QR code with "TICKET CODE ZFY-DCD" underneath, so a saved
// image can still be checked in when the QR code won't scan. The letters are drawn as small
// squares (a 5×7 block font) rather than with a font, so the image looks the same on any server.
const QRCode = require('qrcode');
const sharp = require('sharp');

const GLYPHS = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 10001 11001 10101 10011 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11111 00010 00100 00010 00001 10001 01110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
  '-': '00000 00000 00000 11111 00000 00000 00000', ' ': '00000 00000 00000 00000 00000 00000 00000',
};

// One line of block text, centred in `width`, as SVG squares. `scale` is the size of one dot.
function blockText(text, { width, top, scale, color }) {
  const advance = 6 * scale; // 5 dots + 1 dot gap
  let x = Math.round((width - (text.length * advance - scale)) / 2);
  const rects = [];
  for (const ch of text) {
    const rows = (GLYPHS[ch] || GLYPHS[' ']).split(' ');
    rows.forEach((row, r) => [...row].forEach((bit, c) => {
      if (bit === '1') rects.push(`<rect x="${x + c * scale}" y="${top + r * scale}" width="${scale}" height="${scale}"/>`);
    }));
    x += advance;
  }
  return `<g fill="${color}">${rects.join('')}</g>`;
}

const SIZE = 600;
const FOOTER = 150;

async function ticketPng(url, code) {
  const qr = await QRCode.toBuffer(url, { width: SIZE, margin: 2 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${FOOTER}">
    ${blockText('TICKET CODE', { width: SIZE, top: 6, scale: 4, color: '#5a524b' })}
    ${blockText(code, { width: SIZE, top: 52, scale: 9, color: '#111111' })}
  </svg>`;
  return sharp(qr).extend({ bottom: FOOTER, background: '#ffffff' })
    .composite([{ input: Buffer.from(svg), top: SIZE, left: 0 }]).png().toBuffer();
}

module.exports = { ticketPng };
