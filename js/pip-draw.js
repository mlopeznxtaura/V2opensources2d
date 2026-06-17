/* Circular webcam burn-in for compositor */

function mediaSize(source) {
  if (source instanceof HTMLCanvasElement) {
    return { w: source.width || 640, h: source.height || 480 };
  }
  return { w: source.videoWidth || 640, h: source.videoHeight || 480 };
}

export function drawWebcamPip(ctx, source, x, y, dim) {
  if (!source || (source.videoWidth === 0 && !(source instanceof HTMLCanvasElement))) return;
  const cx = x + dim / 2;
  const cy = y + dim / 2;
  const r = dim / 2;
  const { w: vw, h: vh } = mediaSize(source);
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(source, sx, sy, side, side, x, y, dim, dim);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(2, dim * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.stroke();
}
