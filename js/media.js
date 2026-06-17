/* getUserMedia + recorder helpers — no device blocking */

export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isSafari = (
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  || (isIOS && !/(CriOS|FxiOS|EdgiOS|OPiOS)/.test(navigator.userAgent))
);

export function prepareVideoElement(video) {
  if (!video) return;
  video.muted = true;
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

export async function waitForVideoFrame(video, timeoutMs = 12000) {
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
      setTimeout(() => reject(new Error('Video preview did not start')), timeoutMs);
    }),
  ]);
}

export async function openVideoDevice(deviceId, { passthrough = false } = {}) {
  if (!deviceId) throw new Error('Select a video device.');

  const attempts = passthrough
    ? [
        { video: { deviceId: { ideal: deviceId } } },
        { video: { deviceId: { exact: deviceId } } },
        { video: true },
      ]
    : [
        { video: { deviceId: { ideal: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } },
        { video: { deviceId: { ideal: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        { video: { deviceId: { ideal: deviceId } } },
        { video: { deviceId: { exact: deviceId } } },
      ];

  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }
  throw lastErr || new Error('Could not open video device. Close other apps using it and try again.');
}

export function getDisplayMediaOptions(_sourceValue, includeSystemAudio) {
  if (isSafari || isIOS) return { video: true, audio: !!includeSystemAudio };
  return { video: { cursor: 'always' }, audio: !!includeSystemAudio };
}

export function supportsDisplayCapture() {
  return !!navigator.mediaDevices?.getDisplayMedia;
}

export function supportsMediaRecorderPause() {
  return typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.prototype.pause === 'function';
}

function pickMimeType() {
  const types = (isSafari || isIOS)
    ? ['video/mp4', 'video/mp4;codecs="avc1,mp4a.40.2"', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const type of types) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch (_) {}
  }
  return '';
}

export function createRecorder(stream, bitrate) {
  const preferred = pickMimeType();
  const options = {};
  if (preferred) options.mimeType = preferred;
  if (bitrate && !isIOS) options.videoBitsPerSecond = bitrate;
  try {
    const recorder = Object.keys(options).length
      ? new MediaRecorder(stream, options)
      : new MediaRecorder(stream);
    return { recorder, mimeType: recorder.mimeType || preferred || 'video/webm' };
  } catch (_) {
    const recorder = new MediaRecorder(stream);
    return { recorder, mimeType: recorder.mimeType || 'video/webm' };
  }
}

export function canvasCaptureFps() {
  return (isIOS || isSafari) ? 15 : 30;
}

export function mimeToExtension(mimeType) {
  return (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
}

export async function requestVideoPermission() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach(t => t.stop());
    return true;
  } catch (_) {
    return false;
  }
}

export function findPairedAudioDevice(videoDeviceId, devices) {
  const video = devices.find(d => d.deviceId === videoDeviceId && d.kind === 'videoinput');
  if (!video) return null;
  const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
  if (!audioInputs.length) return null;
  if (video.groupId) {
    const mate = audioInputs.find(d => d.groupId === video.groupId);
    if (mate) return mate;
  }
  const stem = video.label.split('(')[0].trim().toLowerCase();
  if (stem.length > 2) {
    const mate = audioInputs.find(a => a.label.toLowerCase().includes(stem));
    if (mate) return mate;
  }
  const hdmiAudio = audioInputs.filter(a => /digital audio|hdmi|capture|interface|mux/i.test(a.label));
  return hdmiAudio[0] || null;
}

async function attachPairedAudio(videoStream, videoDeviceId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const paired = findPairedAudioDevice(videoDeviceId, devices);
  if (!paired?.deviceId) return '';
  const audioOpts = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    deviceId: { ideal: paired.deviceId },
  };
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: audioOpts, video: false });
    audioStream.getAudioTracks().forEach(t => {
      t.enabled = true;
      videoStream.addTrack(t);
    });
    return paired.label || '';
  } catch (_) {
    return '';
  }
}

export async function openCaptureDevice(deviceId, { withAudio = false } = {}) {
  const stream = await openVideoDevice(deviceId, { passthrough: false });
  if (withAudio) await attachPairedAudio(stream, deviceId);
  return stream;
}

let audioCtx = null;

export async function resumeAudioContexts() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
}

export async function mixAudioTracks(tracks) {
  await resumeAudioContexts();
  const live = tracks.filter(t => t && t.readyState === 'live');
  if (!live.length) return [];
  if (live.length === 1) return live;
  if (!audioCtx) return live;
  const dest = audioCtx.createMediaStreamDestination();
  live.forEach(t => {
    const src = audioCtx.createMediaStreamSource(new MediaStream([t]));
    src.connect(dest);
  });
  return dest.stream.getAudioTracks();
}

export async function openMicStream(deviceId, excludeIds = []) {
  const audio = deviceId
    ? { deviceId: { ideal: deviceId } }
    : true;
  const constraints = { audio, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  if (excludeIds.length) {
    const settings = stream.getAudioTracks()[0]?.getSettings?.();
    if (settings?.deviceId && excludeIds.includes(settings.deviceId)) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('Mic conflicts with capture audio device.');
    }
  }
  return stream;
}
