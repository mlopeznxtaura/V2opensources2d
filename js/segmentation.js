/*
 * Virtual background — BodyPix for physical webcams only.
 * Passthrough virtual cams are never processed.
 */

import { isPassthroughCamera } from './devices.js';

const TEMPORAL_BLEND = 0.72;
const SEG_INTERVAL_MS = 40;

let net = null;
let outputCanvas = null;
let smoothFloat = null;
let smoothU8 = null;
let compositorReady = false;
let loopId = null;
let activeVideo = null;
let frameBusy = false;
let lastSegAt = 0;
let segStatus = '';
let segError = '';

const segOptions = { mode: 'none', bgImage: null, blurPx: 14 };

function bodyPixApi() { return globalThis['body-pix'] || globalThis.bodyPix; }
function tfApi() { return globalThis.tf; }
function libsLoaded() { return !!(tfApi() && bodyPixApi()); }
function videoReady(video) {
  const w = video?.videoWidth;
  const h = video?.videoHeight;
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h);
}

let virtualBgEnabled = true;
export function setVirtualBgEnabled(on) {
  virtualBgEnabled = !!on;
  if (!virtualBgEnabled) compositorReady = false;
}
export function isSegmentationMaskReady() {
  return virtualBgEnabled && compositorReady && !!outputCanvas;
}
export function getCompositedWebcamCanvas() { return outputCanvas; }
export function getSegmentationStatus() { return segStatus; }
export function getSegmentationError() { return segError; }

export async function loadDefaultBackgroundImage() {
  if (segOptions.bgImage?.complete) return segOptions.bgImage;
  const img = new Image();
  img.decoding = 'async';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = 'assets/vbg-studio.svg';
  });
  segOptions.bgImage = img;
  return img;
}

export function setSegmentationOptions(opts = {}) { Object.assign(segOptions, opts); }

function ensureOutputCanvas() {
  if (!outputCanvas) outputCanvas = document.createElement('canvas');
}

function buildSmoothedSegmentation(seg) {
  const { data, width, height } = seg;
  const n = data.length;
  if (!smoothFloat || smoothFloat.length !== n) {
    smoothFloat = new Float32Array(n);
    for (let i = 0; i < n; i++) smoothFloat[i] = data[i];
  } else {
    const keep = 1 - TEMPORAL_BLEND;
    for (let i = 0; i < n; i++) smoothFloat[i] = smoothFloat[i] * keep + data[i] * TEMPORAL_BLEND;
  }
  if (!smoothU8 || smoothU8.length !== n) smoothU8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) smoothU8[i] = smoothFloat[i] > 0.32 ? 1 : 0;
  return { data: smoothU8, width, height };
}

function drawCoverImage(ctx, img, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(w / iw, h / ih);
  ctx.drawImage(img, (w - iw * scale) / 2, (h - ih * scale) / 2, iw * scale, ih * scale);
}

async function renderFrame(video) {
  const bodyPix = bodyPixApi();
  if (!net || !bodyPix || !videoReady(video)) return;
  ensureOutputCanvas();
  const segmentation = await net.segmentPerson(video, {
    flipHorizontal: false,
    internalResolution: 'high',
    segmentationThreshold: 0.55,
    maxDetections: 1,
  });
  if (!videoReady(video)) return;
  const smoothed = buildSmoothedSegmentation(segmentation);
  const edgeBlur = 5;
  const blur = Math.min(20, Math.max(1, Math.round(segOptions.blurPx)));
  if (segOptions.mode === 'image' && segOptions.bgImage?.complete) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    outputCanvas.width = w;
    outputCanvas.height = h;
    const ctx = outputCanvas.getContext('2d');
    drawCoverImage(ctx, segOptions.bgImage, w, h);
    const personCanvas = document.createElement('canvas');
    personCanvas.width = w;
    personCanvas.height = h;
    const pctx = personCanvas.getContext('2d');
    pctx.drawImage(video, 0, 0, w, h);
    const maskImage = bodyPix.toMask(smoothed, { r: 0, g: 0, b: 0, a: 255 }, { r: 0, g: 0, b: 0, a: 0 });
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    const mctx = maskCanvas.getContext('2d');
    mctx.putImageData(maskImage, 0, 0);
    mctx.filter = `blur(${edgeBlur}px)`;
    mctx.drawImage(maskCanvas, 0, 0);
    mctx.filter = 'none';
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(maskCanvas, 0, 0);
    ctx.drawImage(personCanvas, 0, 0);
  } else {
    bodyPix.drawBokehEffect(outputCanvas, video, smoothed, blur, edgeBlur, false);
  }
  compositorReady = true;
  segError = '';
  segStatus = 'Background replaced';
}

async function ensureModel() {
  if (net) return net;
  if (!libsLoaded()) throw new Error('AI libraries missing');
  const tf = tfApi();
  segStatus = 'Loading background AI…';
  try { await tf.setBackend('webgl'); await tf.ready(); }
  catch (_) { await tf.setBackend('cpu'); await tf.ready(); }
  net = await bodyPixApi().load({ architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2 });
  return net;
}

function runLoop() {
  loopId = requestAnimationFrame(runLoop);
  if (frameBusy || !activeVideo || !videoReady(activeVideo)) return;
  const now = performance.now();
  if (now - lastSegAt < SEG_INTERVAL_MS) return;
  lastSegAt = now;
  frameBusy = true;
  renderFrame(activeVideo).catch(err => {
    segError = err.message || String(err);
    compositorReady = false;
  }).finally(() => { frameBusy = false; });
}

export function startSegmentationLoop(video) {
  if (!video) return;
  const label = video.srcObject?.getVideoTracks?.()?.[0]?.label || '';
  if (isPassthroughCamera(label)) return;
  activeVideo = video;
  compositorReady = false;
  ensureModel().then(() => { if (activeVideo === video && !loopId) runLoop(); })
    .catch(err => { segError = err.message || String(err); });
}

export function stopSegmentationLoop() {
  activeVideo = null;
  compositorReady = false;
  if (loopId) { cancelAnimationFrame(loopId); loopId = null; }
}
