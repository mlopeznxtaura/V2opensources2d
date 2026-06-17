/* Shared caption bar metrics — preview DOM, Document PiP, and canvas burn-in */

export const CAPTION_FONT_MIN = 28;
export const CAPTION_FONT_MAX = 48;
export const CAPTION_FONT_VH = 0.022;
export const CAPTION_BOTTOM_VH = 0.028;
export const CAPTION_PAD_VH = 0.014;
export const CAPTION_MAX_WIDTH = 0.88;
export const CAPTION_MAX_LINES = 2;
export const CAPTION_LINE_HEIGHT = 1.35;
export const CAPTION_RADIUS = 10;

export function captionFontSize(vh) {
  return Math.min(CAPTION_FONT_MAX, Math.max(CAPTION_FONT_MIN, Math.round(vh * CAPTION_FONT_VH)));
}

export function getCaptionMetrics(vw, vh) {
  const fontSize = captionFontSize(vh);
  return {
    fontSize,
    pad: Math.max(10, Math.round(vh * CAPTION_PAD_VH)),
    bottom: Math.max(14, Math.round(vh * CAPTION_BOTTOM_VH)),
    maxW: vw * CAPTION_MAX_WIDTH,
    lineH: fontSize * CAPTION_LINE_HEIGHT,
  };
}

export function wrapCaptionLines(ctx, text, maxWidth, maxLines = CAPTION_MAX_LINES) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length > 3 ? `${last.replace(/\s+\S+$/, '')}…` : `${last}…`;
  }
  return lines;
}

/** Burn-in caption at bottom of recording canvas */
export function drawCaptionOnCanvas(ctx, text, vw, vh) {
  const t = (text || '').trim();
  if (!t) return;
  const { fontSize, pad, bottom, maxW, lineH } = getCaptionMetrics(vw, vh);
  const boxW = maxW;
  ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  const lines = wrapCaptionLines(ctx, t, boxW - pad * 2);
  if (!lines.length) return;

  const boxH = lines.length * lineH + pad * 2;
  const boxX = (vw - boxW) / 2;
  const boxY = vh - boxH - bottom;

  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  roundRect(ctx, boxX, boxY, boxW, boxH, CAPTION_RADIUS);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    ctx.fillText(line, vw / 2, boxY + pad + fontSize + i * lineH);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** CSS for Document PiP caption strip (px sizes for PiP window) */
export function pipCaptionCss(fontPx = 15) {
  return `
    .pip-root { display:flex; flex-direction:column; height:100%; background:#0d0e11; overflow:hidden; }
    .pip-webcam-wrap { flex:0 0 auto; position:relative; display:flex; align-items:center; justify-content:center;
      padding:8px; min-height:0; overflow:hidden; }
    .pip-webcam-wrap video { width:100%; max-height:100%; object-fit:cover; aspect-ratio:1;
      clip-path:circle(50% at 50% 50%); -webkit-clip-path:circle(50% at 50% 50%); }
    .pip-caption { flex:0 0 auto; margin:0 8px 8px; padding:10px 14px; border-radius:10px;
      background:rgba(0,0,0,0.75); color:#fff; font:600 ${fontPx}px/1.35 Inter,system-ui,sans-serif;
      text-align:center; word-break:break-word; max-height:4.5em; overflow:hidden; }
    .pip-caption:empty { display:none; }
    .pip-hint { font:10px/1.2 Inter,system-ui,sans-serif; color:#8b8fa8; text-align:center; padding:0 4px 4px; }
    .pip-caption-only .pip-webcam-wrap { display:none; }
  `;
}
