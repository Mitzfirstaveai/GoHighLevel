// Server-rendered SVG charts (no client library): column charts with one or two series and
// horizontal bar charts. Each mark has a <title> for hover/focus, and every chart ships a
// table view so no value depends on hovering.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Clean axis: a 1/2/5 × 10ⁿ step with at most 5 gridlines, topping out just above the data.
function niceScale(max) {
  if (max <= 0) return { top: 4, step: 1 };
  const pow = 10 ** Math.floor(Math.log10(max / 5));
  const step = Math.max(1, [1, 2, 5, 10].find((s) => (s * pow) * 5 >= max) * pow);
  return { top: Math.ceil(max / step) * step, step };
}

// Column top with 4px rounded corners, square at the baseline.
function columnPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function barPath(x, y, w, h) {
  const r = Math.min(4, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

/**
 * Column chart. rows: [{ label, values: [n, …] }]; series: names (1 or 2).
 * format: number -> display string.
 */
function columnChart({ rows, series, format = String, height = 220, title }) {
  const width = 640;
  const pad = { top: 18, right: 8, bottom: 28, left: 56 };
  const plotH = height - pad.top - pad.bottom;
  const plotW = width - pad.left - pad.right;
  const { top: max, step } = niceScale(Math.max(0, ...rows.flatMap((r) => r.values)));
  const band = plotW / Math.max(1, rows.length);
  const barW = Math.min(24, (band * 0.7) / series.length);
  const gap = 2;
  const y = (v) => pad.top + plotH - (v / max) * plotH;
  let svg = '';
  for (let v = 0; v <= max; v += step) {
    svg += `<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"/>`
      + `<text class="tick" x="${pad.left - 6}" y="${y(v) + 4}" text-anchor="end">${esc(format(v))}</text>`;
  }
  const peak = Math.max(...rows.flatMap((r) => r.values));
  rows.forEach((r, i) => {
    const groupW = series.length * barW + (series.length - 1) * gap;
    const x0 = pad.left + i * band + (band - groupW) / 2;
    r.values.forEach((v, s) => {
      const h = Math.max(0, y(0) - y(v));
      const x = x0 + s * (barW + gap);
      const label = `${series.length > 1 ? `${series[s]} · ` : ''}${r.label}: ${format(v)}`;
      svg += `<g class="mark s${s + 1}" tabindex="0"><title>${esc(label)}</title>`
        + `<rect class="hit" x="${x0 - 2}" y="${pad.top}" width="${groupW + 4}" height="${plotH}"/>`
        + (h > 0 ? `<path d="${columnPath(x, y(v), barW, h)}"/>` : '') + '</g>';
      // Label only the peak value; the rest are in the tooltip and table.
      if (v === peak && v > 0 && s === r.values.indexOf(peak)) {
        svg += `<text class="value" x="${x + barW / 2}" y="${y(v) - 5}" text-anchor="middle">${esc(format(v))}</text>`;
      }
    });
    svg += `<text class="tick" x="${pad.left + i * band + band / 2}" y="${height - 8}" text-anchor="middle">${esc(r.label)}</text>`;
  });
  svg += `<line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"/>`;
  return wrap({ svg, width, height, title, series, rows, format });
}

// Horizontal bars, value at the tip. rows: [{ label, value }].
function barChart({ rows, format = String, title }) {
  const rowH = 34;
  const width = 640;
  const labelW = 170;
  const height = rows.length * rowH + 8;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const plotW = width - labelW - 70;
  let svg = '';
  rows.forEach((r, i) => {
    const yy = 4 + i * rowH;
    const w = (r.value / max) * plotW;
    svg += `<text class="cat" x="${labelW - 10}" y="${yy + 20}" text-anchor="end">${esc(r.label)}</text>`
      + `<g class="mark s1" tabindex="0"><title>${esc(`${r.label}: ${format(r.value)}`)}</title>`
      + `<rect class="hit" x="${labelW}" y="${yy}" width="${plotW + 60}" height="${rowH - 2}"/>`
      + (w > 0 ? `<path d="${barPath(labelW, yy + 5, w, 20)}"/>` : '') + '</g>'
      + `<text class="value" x="${labelW + w + 6}" y="${yy + 20}">${esc(format(r.value))}</text>`;
  });
  svg += `<line class="axis" x1="${labelW}" x2="${labelW}" y1="0" y2="${height}"/>`;
  return wrap({ svg, width, height, title, series: [title], rows: rows.map((r) => ({ label: r.label, values: [r.value] })), format });
}

function wrap({ svg, width, height, title, series, rows, format }) {
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s, i) => `<span><i class="key s${i + 1}"></i>${esc(s)}</span>`).join('')}</div>` : '';
  const table = `<details class="chart-table"><summary>Show as table</summary><table><thead><tr><th></th>${series.map((s) => `<th class="num">${esc(s)}</th>`).join('')}</tr></thead><tbody>`
    + rows.map((r) => `<tr><td>${esc(r.label)}</td>${r.values.map((v) => `<td class="num">${esc(format(v))}</td>`).join('')}</tr>`).join('')
    + '</tbody></table></details>';
  return `<figure class="chart">${legend}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${svg}</svg>${table}</figure>`;
}

module.exports = { columnChart, barChart };
