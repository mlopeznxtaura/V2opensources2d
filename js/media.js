/* Browser media utilities — recorders, display capture, audio mix. No camera auto-pick. */

export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isSafari = (
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  || (isIOS && !/(CriOS|FxiOS|EdgiOS|OPiOS)/.test(navigator.userAgent))
);

export function prepareVideoElement(video) {
  if (!video) return;
  if (video.dataset.hear !== '1') video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
}

export async function playVideo(video) {
  prepareVideoElement(video);
  try {
    await video.play();
  } catch (_) {
    await new Promise(resolve => {
      if (video.readyState >= 2) { resolve(); return; }
      video.addEventListener('loadeddata', resolve, { once: true });
    });
    await video.play().catch(() => {});
  }
}

export async function waitForVideoFrame(video, timeoutMs = 15000) {
  if (video.videoWidth > 0 && video.readyState >= 2) return;
  await Promise.race([
    new Promise((resolve, reject) => {
      const check = () => {
        if (video.videoWidth > 0 && video.readyState >= 2) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        video.removeEventListener('loadeddata', check);
        video.removeEventListener('playing', check);
        video.removeEventListener('resize', check);
      };
      video.addEventListener('loadeddata', check);
      video.addEventListener('playing', check);
      video.addEventListener('resize', check);
      check();
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Video did not produce frames')), timeoutMs);
    }),
  ]);
}

const DISPLAY_SURFACE = { screen: 'monitor', window: 'window', tab: 'browser' };

export function getDisplayMediaOptions(sourceValue, includeSystemAudio) {
  if (isSafari || isIOS) return { video: true, audio: !!includeSystemAudio };
  const displaySurface = DISPLAY_SURFACE[sourceValue] || 'monitor';
  return {
    video: { cursor: 'always', displaySurface },
    audio: !!includeSystemAudio,
    // Never offer this recorder tab — capturing it composites into itself and melts.
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
  };
}

export function supportsMediaRecorderPause() {
  return typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.prototype.pause === 'function';
}

function pickMimeType() {
  // Match app1 (260820-voice): Chrome canvas capture is reliable as WebM.
  // Forcing H.264+AAC MP4 often yields files Windows cannot open.
  const types = (isSafari || isIOS)
    ? ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
    : [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
  for (const type of types) {
    try { if (MediaRecorder.isTypeSupported(type)) return type; } catch (_) {}
  }
  return '';
}

export function createRecorder(stream, bitrate) {
  const preferred = pickMimeType();
  const options = {};
  if (preferred) options.mimeType = preferred;
  if (bitrate && !isIOS) options.videoBitsPerSecond = bitrate;
  if (!isIOS) options.audioBitsPerSecond = 256_000;
  const recorder = Object.keys(options).length
    ? new MediaRecorder(stream, options)
    : new MediaRecorder(stream);
  return { recorder, mimeType: recorder.mimeType || preferred || 'video/webm' };
}

export function canvasCaptureFps() {
  return (isIOS || isSafari) ? 15 : 30;
}

export function mimeToExtension(mimeType) {
  return (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
}

let audioCtx = null;
let mixGraph = [];
let hdmiMonitorNode = null;

export async function resumeAudioContexts() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
}

/** Mix originals (not clones) so Chrome actually emits samples into MediaRecorder. */
export async function mixAudioTracks(tracks, { hear = false } = {}) {
  await resumeAudioContexts();
  mixGraph.forEach(n => { try { n.disconnect(); } catch (_) {} });
  mixGraph = [];
  const live = tracks.filter(t => t && t.readyState === 'live');
  live.forEach(t => { t.enabled = true; });
  if (!live.length) return [];
  if (!audioCtx) return live;
  const dest = audioCtx.createMediaStreamDestination();
  live.forEach(t => {
    try {
      const src = audioCtx.createMediaStreamSource(new MediaStream([t]));
      src.connect(dest);
      mixGraph.push(src);
    } catch (_) {}
  });
  mixGraph.push(dest);
  if (hear) {
    try {
      const tap = audioCtx.createMediaStreamSource(dest.stream);
      tap.connect(audioCtx.destination);
      mixGraph.push(tap);
    } catch (_) {}
  }
  const mixed = dest.stream.getAudioTracks();
  mixed.forEach(t => { t.enabled = true; });
  return mixed.length ? mixed : live;
}

export async function openMicStream(deviceId) {
  const processing = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const attempts = deviceId
    ? [
        { audio: { deviceId: { exact: deviceId }, ...processing }, video: false },
        { audio: { deviceId: { ideal: deviceId }, ...processing }, video: false },
      ]
    : [{ audio: processing, video: false }];
  let lastErr;
  for (const c of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(c);
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }
  throw lastErr || new Error('Microphone unavailable');
}

export async function openHdmiAudioStream(deviceId) {
  const raw = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
  };
  const attempts = deviceId
    ? [
        { audio: { deviceId: { exact: deviceId }, ...raw }, video: false },
        { audio: { deviceId: { ideal: deviceId }, ...raw }, video: false },
      ]
    : [];
  let lastErr;
  for (const c of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(c);
      const label = stream.getAudioTracks()[0]?.label || '';
      if (/usb camera|link camera|webcam|microphone array|headset/i.test(label)) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('Browser opened the webcam mic instead of HDMI audio.');
      }
      stream.getAudioTracks().forEach(t => { t.enabled = true; });
      return stream;
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }
  throw lastErr || new Error('HDMI audio unavailable');
}

export async function startHdmiAudioMonitor(stream) {
  stopHdmiAudioMonitor();
  const tracks = stream?.getAudioTracks?.().filter(t => t.readyState === 'live') || [];
  if (!tracks.length) return false;
  await resumeAudioContexts();
  if (!audioCtx) return false;
  try {
    hdmiMonitorNode = audioCtx.createMediaStreamSource(new MediaStream(tracks));
    hdmiMonitorNode.connect(audioCtx.destination);
    return true;
  } catch (_) {
    return false;
  }
}

export function stopHdmiAudioMonitor() {
  if (hdmiMonitorNode) {
    try { hdmiMonitorNode.disconnect(); } catch (_) {}
    hdmiMonitorNode = null;
  }
}

/** Unlocks device labels in Chrome. Stops the temp track immediately — does not keep a camera open. */
export async function requestVideoPermission() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach(t => t.stop());
    return true;
  } catch (_) {
    return false;
  }
}

export async function requestAudioPermission() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    tmp.getTracks().forEach(t => t.stop());
    return true;
  } catch (_) {
    return false;
  }
}

/** Hidden in-DOM video for screen decode (must be attached for reliable frames). */
export function mountHiddenVideo(id = 'screenDecode') {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('video');
    el.id = id;
    el.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(el);
  }
  prepareVideoElement(el);
  return el;
}
