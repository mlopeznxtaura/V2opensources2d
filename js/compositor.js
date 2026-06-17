/* Canvas compositor — screen + capture overlay + webcam PiP + captions */

import { drawWebcamPip } from './pip-draw.js';
import { drawCaptionOnCanvas } from './caption-style.js';
import { isSegmentationMaskReady, getCompositedWebcamCanvas } from './segmentation.js';

export function createCompositor({ screenVideo, captureCardVideo, webcamVideo, canvas }) {
  const ctx = canvas.getContext('2d');
  let rafId = null;
  let webcamPip = { x: 0.82, y: 0.82, size: 0.28 };
  let capturePip = { x: 0.18, y: 0.82, w: 0.28, h: 0.16 };
  let captureEnabled = false;
  let captureAsMain = false;
  let captionText = '';
  let webcamOnCanvas = true;
  let webcamPassthrough = false;

  function setWebcamPassthrough(on) { webcamPassthrough = !!on; }
  function setCaptureAsMain(on) { captureAsMain = !!on; }
  function setCaptureEnabled(on) { captureEnabled = !!on; }
  function setWebcamOnCanvas(on) { webcamOnCanvas = on !== false; }
  function setCaption(text) { captionText = (text || '').trim(); }

  function setPipFromElement(pipEl, containerEl, target = 'webcam') {
    if (!pipEl || !containerEl || pipEl.classList.contains('hidden')) return;
    const c = containerEl.getBoundingClientRect();
    const p = pipEl.getBoundingClientRect();
    if (!c.width || !c.height) return;
    if (target === 'capture') {
      capturePip = {
        x: (p.left - c.left + p.width / 2) / c.width,
        y: (p.top - c.top + p.height / 2) / c.height,
        w: Math.max(0.12, Math.min(0.5, p.width / c.width)),
        h: Math.max(0.08, Math.min(0.35, p.height / c.height)),
      };
      return;
    }
    const size = Math.max(p.width, p.height) / Math.min(c.width, c.height);
    webcamPip = {
      x: (p.left - c.left + p.width / 2) / c.width,
      y: (p.top - c.top + p.height / 2) / c.height,
      size: Math.max(0.06, Math.min(0.35, size)),
    };
  }

  function drawFrame() {
    const capReady = captureCardVideo?.srcObject && captureCardVideo.readyState >= 2 && captureCardVideo.videoWidth > 0;
    let vw = screenVideo.videoWidth || 0;
    let vh = screenVideo.videoHeight || 0;
    if (captureAsMain && capReady) {
      vw = captureCardVideo.videoWidth;
      vh = captureCardVideo.videoHeight;
    }
    if (!vw || !vh) {
      vw = capReady ? captureCardVideo.videoWidth : 1280;
      vh = capReady ? captureCardVideo.videoHeight : 720;
    }
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);

    if (captureAsMain && capReady) {
      ctx.drawImage(captureCardVideo, 0, 0, vw, vh);
    } else if (screenVideo.readyState >= 2 && screenVideo.videoWidth > 0) {
      ctx.drawImage(screenVideo, 0, 0, vw, vh);
    }

    if (!captureAsMain && captureEnabled && capReady) {
      const pw = vw * capturePip.w;
      const ph = vh * capturePip.h;
      const px = Math.max(pw / 2, Math.min(vw - pw / 2, capturePip.x * vw)) - pw / 2;
      const py = Math.max(ph / 2, Math.min(vh - ph / 2, capturePip.y * vh)) - ph / 2;
      ctx.save();
      roundRect(ctx, px, py, pw, ph, 8);
      ctx.clip();
      ctx.drawImage(captureCardVideo, px, py, pw, ph);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 140, 66, 0.55)';
      ctx.lineWidth = Math.max(2, vw * 0.002);
      roundRect(ctx, px, py, pw, ph, 8);
      ctx.stroke();
    }

    const composited = !webcamPassthrough && isSegmentationMaskReady() ? getCompositedWebcamCanvas() : null;
    const camSource = composited || webcamVideo;
    const camReady = composited
      ? composited.width > 0
      : webcamVideo?.srcObject && webcamVideo.readyState >= 2 && webcamVideo.videoWidth > 0;
    if (webcamOnCanvas && camSource && camReady) {
      const dim = Math.min(vw, vh) * webcamPip.size;
      const cx = webcamPip.x * vw;
      const cy = webcamPip.y * vh;
      const x = Math.max(dim / 2, Math.min(vw - dim / 2, cx)) - dim / 2;
      const y = Math.max(dim / 2, Math.min(vh - dim / 2, cy)) - dim / 2;
      ctx.save();
      drawWebcamPip(ctx, camSource, x, y, dim);
      ctx.restore();
    }

    if (captionText) drawCaptionOnCanvas(ctx, captionText, vw, vh);
    rafId = requestAnimationFrame(drawFrame);
  }

  function start() {
    stop();
    rafId = requestAnimationFrame(drawFrame);
  }

  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  return {
    start, stop, setPipFromElement, setCaption, setWebcamOnCanvas,
    setCaptureEnabled, setCaptureAsMain, setWebcamPassthrough,
  };
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
