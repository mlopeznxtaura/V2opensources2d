/* Video feed — one DOM <video>, one stream, exact deviceId only. */

import { prepareVideoElement, playVideo } from './media.js';
import { assertOpenedDevice, formatVideoOpenError, isPassthroughCamera, videoTrackLabel } from './devices.js';

export class VideoFeed {
  /** @param {HTMLVideoElement} videoEl must be in the document */
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.stream = null;
    this.deviceId = null;
    prepareVideoElement(videoEl);
  }

  get label() {
    return videoTrackLabel(this.stream);
  }

  get passthrough() {
    return isPassthroughCamera(this.stream) || isPassthroughCamera(this.label);
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.deviceId = null;
    this.videoEl.srcObject = null;
  }

  async open(deviceId, deviceLabel = '', { audio = false } = {}) {
    if (!deviceId) throw new Error('No device selected.');
    const already = this.deviceId === deviceId && this.stream;
    const haveAudio = !!this.stream?.getAudioTracks().some(t => t.readyState === 'live');
    if (already && (!audio || haveAudio)) return this.stream;

    this.stop();

    const rawAudio = (id) => {
      const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (id === true) return base;
      return { deviceId: { exact: id }, ...base };
    };
    const audioConstraint = audio ? rawAudio(audio) : false;
    const pass = isPassthroughCamera(deviceLabel);
    const videoAttempts = pass
      ? [
          { deviceId: { exact: deviceId } },
          { deviceId: { ideal: deviceId } },
        ]
      : [
          { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          { deviceId: { exact: deviceId } },
          { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
          { deviceId: { ideal: deviceId } },
        ];

    const constraints = [];
    if (audioConstraint) {
      // Pairing audio:true with the capture-card video is how Windows HDMI cards expose game sound.
      videoAttempts.forEach(video => constraints.push({ video, audio: rawAudio(true) }));
      if (audio !== true) {
        videoAttempts.forEach(video => constraints.push({ video, audio: audioConstraint }));
      }
    }
    videoAttempts.forEach(video => constraints.push({ video, audio: false }));

    let lastErr;
    for (const c of constraints) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c);
        assertOpenedDevice(stream, deviceId);
        this.stream = stream;
        this.deviceId = deviceId;
        this.videoEl.srcObject = stream;
        this.videoEl.dataset.hear = audio ? '1' : '';
        this.videoEl.muted = !audio;
        await playVideo(this.videoEl);
        if (audio) this.videoEl.muted = false;
        return stream;
      } catch (err) {
        lastErr = err;
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
      }
    }
    throw formatVideoOpenError(lastErr, deviceLabel || 'That camera');
  }

  show() { this.videoEl.classList.remove('hidden'); }
  hide() { this.videoEl.classList.add('hidden'); }
}

export async function listVideoInputs() {
  return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId);
}

export async function refreshDeviceLists(camSelect, capSelect, micSelect, hdmiAudioSelect) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const camId = camSelect?.value;
  const capId = capSelect?.value;
  const micId = micSelect?.value;
  const hdmiId = hdmiAudioSelect?.value;
  fillVideoSelect(camSelect, devices.filter(d => d.kind === 'videoinput'), camId);
  fillVideoSelect(capSelect, devices.filter(d => d.kind === 'videoinput'), capId);
  fillAudioSelect(micSelect, devices.filter(d => d.kind === 'audioinput'), micId);
  fillAudioSelect(hdmiAudioSelect, devices.filter(d => d.kind === 'audioinput'), hdmiId, 'Auto-pair with capture card');
}

function fillVideoSelect(sel, devices, keepId) {
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    const name = d.label || `Video input ${i + 1}`;
    opt.text = isPassthroughCamera(d) ? `${name} (passthrough)` : name;
    sel.appendChild(opt);
  });
  if (keepId && [...sel.options].some(o => o.value === keepId)) sel.value = keepId;
}

function fillAudioSelect(sel, devices, keepId, emptyLabel) {
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  if (emptyLabel && sel.options[0]) sel.options[0].text = emptyLabel;
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text = d.label || `Microphone ${i + 1}`;
    sel.appendChild(opt);
  });
  if (keepId && [...sel.options].some(o => o.value === keepId)) sel.value = keepId;
}

export function selectedLabel(selectEl) {
  return selectEl?.selectedOptions?.[0]?.text || '';
}
