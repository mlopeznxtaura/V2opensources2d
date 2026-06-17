/* Video feed — one DOM <video>, one stream, exact deviceId only. */

import { prepareVideoElement, playVideo } from './media.js';
import { assertOpenedDevice, isPassthroughCamera, videoTrackLabel } from './devices.js';

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

  async open(deviceId, deviceLabel = '') {
    if (!deviceId) throw new Error('No device selected.');
    if (this.deviceId === deviceId && this.stream) return this.stream;

    this.stop();

    const pass = isPassthroughCamera(deviceLabel);
    const constraints = pass
      ? [
          { video: { deviceId: { exact: deviceId } }, audio: false },
          { video: { deviceId: { ideal: deviceId } }, audio: false },
        ]
      : [
          { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
          { video: { deviceId: { ideal: deviceId } }, audio: false },
          { video: { deviceId: { exact: deviceId } }, audio: false },
        ];

    let lastErr;
    for (const c of constraints) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c);
        assertOpenedDevice(stream, deviceId);
        this.stream = stream;
        this.deviceId = deviceId;
        this.videoEl.srcObject = stream;
        await playVideo(this.videoEl);
        return stream;
      } catch (err) {
        lastErr = err;
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
      }
    }
    throw lastErr || new Error('Could not open that device. Close other apps using it.');
  }

  show() { this.videoEl.classList.remove('hidden'); }
  hide() { this.videoEl.classList.add('hidden'); }
}

export async function listVideoInputs() {
  return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId);
}

export async function refreshDeviceLists(camSelect, capSelect, micSelect) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const camId = camSelect?.value;
  const capId = capSelect?.value;
  const micId = micSelect?.value;
  fillVideoSelect(camSelect, devices.filter(d => d.kind === 'videoinput'), camId);
  fillVideoSelect(capSelect, devices.filter(d => d.kind === 'videoinput'), capId);
  fillAudioSelect(micSelect, devices.filter(d => d.kind === 'audioinput'), micId);
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

function fillAudioSelect(sel, devices, keepId) {
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
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
