// Minimal canvas line chart — no charting library, matches how the map
// viewers in this project family already do all their own canvas rendering.
//
// Points are placed by actual elapsed time (rangeStartSec..rangeEndSec), not
// evenly by array index. A player with only 2 polls in a 90-day window used
// to get a line stretched corner-to-corner across the whole sparkline as if
// it were a smooth 90-day trend; now it's placed at its real position in
// time, and a player who went stale partway through the range just shows a
// line that stops short of the right edge — a visible gap for "nothing
// polled after this point" instead of a misleadingly continuous line.
export function drawSparkline(canvas, points, { rangeStartSec, rangeEndSec, color = "#6bb6f2" } = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 96;
  const height = canvas.clientHeight || 28;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const valid = (points || []).filter((p) => p.outpost_count !== null && p.outpost_count !== undefined);
  if (valid.length < 2) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.fillRect(0, height - 1, width, 1);
    return;
  }

  const values = valid.map((p) => p.outpost_count);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;

  const start = rangeStartSec ?? valid[0].polled_at;
  const end = Math.max(rangeEndSec ?? valid[valid.length - 1].polled_at, start + 1);

  const xFor = (t) => pad + Math.min(Math.max((t - start) / (end - start), 0), 1) * (width - pad * 2);
  const yFor = (v) => pad + (1 - (v - min) / range) * (height - pad * 2);

  ctx.beginPath();
  valid.forEach((p, i) => {
    const x = xFor(p.polled_at);
    const y = yFor(p.outpost_count);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const last = valid[valid.length - 1];
  ctx.beginPath();
  ctx.arc(xFor(last.polled_at), yFor(last.outpost_count), 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}
