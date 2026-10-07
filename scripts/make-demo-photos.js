// Generates the illustrated stand-in photos used by the demo albums (demo/photos/*.jpg).
// Run once with `node scripts/make-demo-photos.js`; the output is committed so seeding needs no image work.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const W = 1200;
const H = 900;
const OUT = path.join(__dirname, '..', 'demo', 'photos');

function rng(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const SKIN = ['#8d5524', '#a86b3c', '#c68642', '#b5794b', '#7a4a26'];
const BRIGHT = ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#d62889', '#ff7f11', '#7b2cbf', '#06d6a0', '#ef476f', '#ffd166'];

function person(r, x, y, s, { skirt = false, color } = {}) {
  const c = color || pick(r, BRIGHT);
  const body = skirt
    ? `<path d="M${x} ${y + 18 * s} L${x - 26 * s} ${y + 78 * s} L${x + 26 * s} ${y + 78 * s} Z" fill="${c}"/>`
    : `<rect x="${x - 14 * s}" y="${y + 16 * s}" width="${28 * s}" height="${46 * s}" rx="${8 * s}" fill="${c}"/>
       <rect x="${x - 12 * s}" y="${y + 60 * s}" width="${9 * s}" height="${24 * s}" fill="#333"/><rect x="${x + 3 * s}" y="${y + 60 * s}" width="${9 * s}" height="${24 * s}" fill="#333"/>`;
  return `${body}<circle cx="${x}" cy="${y}" r="${13 * s}" fill="${pick(r, SKIN)}"/><path d="M${x - 13 * s} ${y - 3 * s} q${13 * s} ${-16 * s} ${26 * s} 0" fill="#222"/>`;
}

function diya(x, y, s) {
  return `<ellipse cx="${x}" cy="${y + 10 * s}" rx="${34 * s}" ry="${14 * s}" fill="#9c4a1a"/><path d="M${x - 34 * s} ${y + 6 * s} q${34 * s} ${30 * s} ${68 * s} 0" fill="#b5541c"/>
    <circle cx="${x}" cy="${y - 12 * s}" r="${30 * s}" fill="#ffb703" opacity=".18"/><path d="M${x} ${y - 34 * s} q${12 * s} ${20 * s} 0 ${32 * s} q${-12 * s} ${-12 * s} 0 ${-32 * s}" fill="#ffd166"/>`;
}

const SCENES = {
  garba(r) {
    const n = 7 + Math.floor(r() * 5);
    const rot = r() * Math.PI;
    let s = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b0f4c"/><stop offset="1" stop-color="#7a1f3d"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>`;
    for (let i = 0; i < 40; i++) s += `<circle cx="${i * 31 + 10}" cy="${60 + 40 * Math.sin(i / 4)}" r="6" fill="${pick(r, BRIGHT)}"/>`;
    s += `<ellipse cx="600" cy="640" rx="500" ry="170" fill="#4a1530"/>`;
    const dancers = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      dancers.push({ x: 600 + Math.cos(a) * 380, y: 520 + Math.sin(a) * 110, s: 1.2 + Math.sin(a) * 0.35 });
    }
    dancers.sort((a, b) => a.y - b.y);
    s += `<g><path d="M560 560 h80 l-10 60 h-60 z" fill="#c1121f"/><circle cx="600" cy="545" r="30" fill="#e85d04"/>${diya(600, 505, 0.6)}</g>`;
    for (const d of dancers) s += person(r, d.x, d.y - 60 * d.s, d.s, { skirt: r() > 0.35 });
    return s;
  },
  diwali(r) {
    let s = `<rect width="${W}" height="${H}" fill="#0b1d3a"/>`;
    for (let k = 0; k < 4; k++) {
      const cx = 150 + r() * 900; const cy = 100 + r() * 260; const c = pick(r, BRIGHT);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2; const len = 60 + r() * 50;
        s += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a) * len}" y2="${cy + Math.sin(a) * len}" stroke="${c}" stroke-width="3" stroke-linecap="round" opacity=".9"/>`;
      }
    }
    s += `<rect y="620" width="${W}" height="280" fill="#3d1f0f"/>`;
    if (r() > 0.4) {
      for (let ring = 5; ring > 0; ring--) {
        for (let i = 0; i < ring * 6; i++) {
          const a = (i / (ring * 6)) * Math.PI * 2;
          s += `<circle cx="${600 + Math.cos(a) * ring * 28}" cy="${770 + Math.sin(a) * ring * 12}" r="${9}" fill="${BRIGHT[(ring + i) % BRIGHT.length]}"/>`;
        }
      }
    }
    for (let i = 0; i < 7; i++) s += diya(110 + i * 165, 660, 1.1);
    return s;
  },
  festival(r) {
    let s = `<defs><radialGradient id="g" cx=".5" cy=".4" r=".8"><stop offset="0" stop-color="#ffd6a5"/><stop offset="1" stop-color="#e85d04"/></radialGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>`;
    for (let g = 0; g < 3; g++) {
      for (let i = 0; i <= 30; i++) {
        const x = i * 40; const y = 40 + g * 45 + Math.sin((i / 30) * Math.PI) * 90;
        s += `<circle cx="${x}" cy="${y}" r="16" fill="${g % 2 ? '#ffb703' : '#fb8500'}"/>`;
      }
    }
    s += `<rect x="250" y="640" width="700" height="40" rx="20" fill="#b5541c"/>`;
    for (let i = 0; i < 9; i++) {
      const x = 330 + i * 68;
      s += `<path d="M${x} 640 q-28 -10 -24 -40 q24 -50 24 -60 q0 10 24 60 q4 30 -24 40z" fill="#fff3d6" stroke="#e9c46a" stroke-width="3"/>`;
    }
    s += diya(180, 600, 1.4) + diya(1020, 600, 1.4);
    for (let i = 0; i < 4; i++) s += person(r, 150 + i * 300 + r() * 60, 720, 1.3);
    return s;
  },
  picnic(r) {
    let s = `<rect width="${W}" height="${H}" fill="#8ecae6"/><circle cx="${950 + r() * 150}" cy="140" r="70" fill="#ffd166"/>
      <path d="M0 520 q300 -120 600 0 t600 0 v380 h-1200z" fill="#52b788"/><path d="M0 600 q400 -80 800 20 t600 0 v300 h-1400z" fill="#40916c"/>`;
    for (let i = 0; i < 4; i++) {
      const x = 80 + i * 330 + r() * 60;
      s += `<rect x="${x - 10}" y="420" width="20" height="120" fill="#7f5539"/><circle cx="${x}" cy="400" r="70" fill="#2d6a4f"/>`;
    }
    s += `<path d="M330 700 l540 0 l60 120 l-660 0 z" fill="#e63946"/>`;
    for (let i = 0; i < 6; i++) s += `<line x1="${330 + i * 108}" y1="700" x2="${270 + i * 132}" y2="820" stroke="#fff" stroke-width="10" opacity=".6"/>`;
    for (let i = 0; i < 5; i++) s += person(r, 300 + i * 150 + r() * 40, 600, 1.2, { skirt: r() > 0.5 });
    return s;
  },
  volleyball(r) {
    let s = `<rect width="${W}" height="${H}" fill="#a2d2ff"/><rect y="560" width="${W}" height="340" fill="#e9c46a"/>
      <rect x="595" y="300" width="10" height="330" fill="#555"/><rect x="200" y="330" width="800" height="120" fill="none" stroke="#fff" stroke-width="4"/>`;
    for (let i = 0; i < 20; i++) s += `<line x1="${200 + i * 40}" y1="330" x2="${200 + i * 40}" y2="450" stroke="#fff" stroke-width="2"/>`;
    for (let j = 0; j < 3; j++) s += `<line x1="200" y1="${360 + j * 30}" x2="1000" y2="${360 + j * 30}" stroke="#fff" stroke-width="2"/>`;
    const bx = 300 + r() * 600;
    s += `<circle cx="${bx}" cy="200" r="38" fill="#fff" stroke="#ffb703" stroke-width="6"/><path d="M${bx - 38} 200 q38 -30 76 0" stroke="#219ebc" stroke-width="5" fill="none"/>`;
    for (let i = 0; i < 3; i++) s += person(r, 250 + i * 120, 560, 1.5, { color: '#d62828' }) + person(r, 720 + i * 120, 560, 1.5, { color: '#023e8a' });
    return s;
  },
  kites(r) {
    let s = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4cc9f0"/><stop offset="1" stop-color="#caf0f8"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/><rect y="760" width="${W}" height="140" fill="#b08968"/>`;
    for (let i = 0; i < 9; i++) {
      const x = 80 + r() * 1040; const y = 80 + r() * 480; const k = 40 + r() * 40; const c = pick(r, BRIGHT);
      s += `<path d="M${x} ${y - k} L${x + k * 0.8} ${y} L${x} ${y + k} L${x - k * 0.8} ${y} Z" fill="${c}"/>
        <line x1="${x}" y1="${y - k}" x2="${x}" y2="${y + k}" stroke="#333" stroke-width="2"/>
        <path d="M${x} ${y + k} q20 30 0 60 q-20 30 0 60" stroke="${c}" stroke-width="4" fill="none"/>
        <line x1="${x}" y1="${y + k}" x2="${300 + i * 70}" y2="760" stroke="#555" stroke-width="1" opacity=".5"/>`;
    }
    for (let i = 0; i < 5; i++) s += person(r, 260 + i * 160, 690, 1.1);
    return s;
  },
  bhajan(r) {
    let s = `<rect width="${W}" height="${H}" fill="#5c2a0d"/><rect y="0" width="${W}" height="120" fill="#7f3b10"/>`;
    for (let i = 0; i <= 24; i++) s += `<circle cx="${i * 50}" cy="${110 + Math.sin(i / 2) * 12}" r="13" fill="${i % 2 ? '#ffb703' : '#fb8500'}"/>`;
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 6; i++) s += person(r, 170 + i * 175 + (row % 2) * 60, 330 + row * 170, 1.3 + row * 0.15, { skirt: r() > 0.5 });
    }
    for (let i = 0; i < 5; i++) s += diya(200 + i * 200, 840, 0.9);
    return s;
  },
};

// album key → [scene, how many photos]
const ALBUMS = { garba: 6, diwali: 5, festival: 4, picnic: 4, volleyball: 3, kites: 3, bhajan: 2 };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let seed = 7;
  for (const [scene, count] of Object.entries(ALBUMS)) {
    for (let i = 1; i <= count; i++) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${SCENES[scene](rng(seed++ * 7919))}</svg>`;
      const base = path.join(OUT, `${scene}-${i}`);
      await sharp(Buffer.from(svg)).jpeg({ quality: 80, mozjpeg: true }).toFile(`${base}.jpg`);
      await sharp(Buffer.from(svg)).resize(480, 480, { fit: 'cover' }).jpeg({ quality: 76, mozjpeg: true }).toFile(`${base}_t.jpg`);
    }
  }
  console.log('Demo photos written to', OUT);
})();
