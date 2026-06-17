/* V2 Screen2Demo — app5.nextaura.fit */

import { createCompositor } from './compositor.js';
import {
  startSegmentationLoop, stopSegmentationLoop, setSegmentationOptions,
  loadDefaultBackgroundImage, getSegmentationStatus, getSegmentationError,
  setVirtualBgEnabled,
} from './segmentation.js';
import {
  buildMeetingNotes, buildCaptionsMd, downloadText, downloadActionPlanPdf,
  buildTranscript, mergeExportCues,
} from './plan-export.js';
import { resetSession } from './session.js';
import {
  resolveDeviceId, isPassthroughCamera, videoTrackLabel, isStreamLive,
} from './devices.js';
import {
  isIOS, isSafari, supportsDisplayCapture, supportsMediaRecorderPause,
  prepareVideoElement, playVideo, waitForVideoFrame, mixAudioTracks,
  openVideoDevice, getDisplayMediaOptions, createRecorder, canvasCaptureFps,
  mimeToExtension, requestVideoPermission, openCaptureDevice, openMicStream,
  findPairedAudioDevice, resumeAudioContexts,
} from './media.js';

const BUILD = '260617-v2';
const $ = id => document.getElementById(id);

let screenStream = null;
let webcamStream = null;
let captureCardStream = null;
let micStream = null;
let mixedStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordMimeType = '';
let startTime = 0;
let totalPaused = 0;
let pauseStart = 0;
let timerInterval = null;
let webcamPos = 'bottom-right';
let captureCardPos = 'bottom-left';
let recordIntent = { video: true, notesPlan: true, vtt: true };
let pendingExport = null;

const screenCapture = document.createElement('video');
prepareVideoElement(screenCapture);

const screenPreview = $('screenPreview');
const composeCanvas = $('composeCanvas');
const captureCardPip = $('captureCardPip');
const webcamPip = $('webcamPip');
const previewContainer = $('previewContainer');
const previewIdle = $('previewIdle');
const recordBtn = $('recordBtn');
const pauseBtn = $('pauseBtn');
const webcamToggle = $('webcamToggle');
const webcamOptions = $('webcamOptions');
const captureCardToggle = $('captureCardToggle');
const captureCardOptions = $('captureCardOptions');
const camSizeSlider = $('camSize');
const camSizeVal = $('camSizeVal');
const micAudioChk = $('micAudio');

[screenPreview, webcamPip, captureCardPip].forEach(prepareVideoElement);

const compositor = createCompositor({
  screenVideo: screenCapture,
  captureCardVideo: captureCardPip,
  webcamVideo: webcamPip,
  canvas: composeCanvas,
});

function setStatus(kind, text) {
  $('statusIndicator').className = 'status-indicator ' + (kind || '');
  $('statusText').textContent = text || 'Ready';
}

function getVideoBitrate() {
  const q = document.querySelector('input[name="quality"]:checked')?.value || '1080';
  if (q === '4k') return 20_000_000;
  if (q === '720') return 4_000_000;
  return 8_000_000;
}

function formatTimer(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    let paused = totalPaused;
    if (pauseStart && mediaRecorder?.state === 'paused') paused += Date.now() - pauseStart;
    $('timerDisplay').textContent = formatTimer(Date.now() - startTime - paused);
  }, 250);
}

function stopTimer() {
  clearInterval(timerInterval);
  $('timerDisplay').textContent = '00:00:00';
}

function isRecordingActive() {
  return mediaRecorder && mediaRecorder.state !== 'inactive';
}

function fillSelect(sel, items, labelFn, storedId) {
  if (!sel) return;
  const prev = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  items.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text = labelFn(d, i);
    sel.appendChild(opt);
  });
  const pick = [prev, storedId].find(id => id && [...sel.options].some(o => o.value === id));
  if (pick) sel.value = pick;
}

async function enumerateDevices() {
  try {
    if (isIOS || isSafari) await requestVideoPermission();
    else {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null));
      if (tmp) tmp.getTracks().forEach(t => t.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const cams = devices.filter(d => d.kind === 'videoinput');
    fillSelect($('micSelect'), mics, (d, i) => d.label || `Microphone ${i + 1}`);
    const camLabel = d => {
      const n = d.label || 'Camera';
      return isPassthroughCamera(d) ? `${n} (passthrough)` : n;
    };
    fillSelect($('camSelect'), cams, camLabel, localStorage.getItem('v2.webcam'));
    fillSelect($('captureCardSelect'), cams, (d, i) => d.label || `Video ${i + 1}`, localStorage.getItem('v2.capture'));
  } catch (e) {
    console.warn('enumerateDevices:', e);
  }
}

enumerateDevices();
navigator.mediaDevices?.addEventListener?.('devicechange', enumerateDevices);

function updateWebcamStatus() {
  const el = $('webcamDeviceStatus');
  if (!el || !webcamToggle.checked) { if (el) el.textContent = ''; return; }
  const live = videoTrackLabel(webcamStream);
  if (!live) { el.textContent = ''; return; }
  el.textContent = isPassthroughCamera(live)
    ? `Live: ${live} — passthrough`
    : `Live: ${live}`;
}

function syncPassthroughUi() {
  const pass = isPassthroughCamera(webcamStream) || isPassthroughCamera($('camSelect')?.selectedOptions?.[0]?.text || '');
  compositor.setWebcamPassthrough(pass);
  setVirtualBgEnabled(!pass);
  const block = $('virtualBgBlock');
  if (pass) {
    stopVirtualBg();
    $('virtualBgToggle').checked = false;
    block?.classList.add('hidden');
    if ($('virtualBgStatus')) $('virtualBgStatus').textContent = 'Virtual cam — stream used as-is';
  } else {
    block?.classList.remove('hidden');
    if ($('virtualBgStatus')) $('virtualBgStatus').textContent = '';
  }
}

function isVirtualBgOn() {
  return webcamToggle.checked && $('virtualBgToggle')?.checked && !isPassthroughCamera(webcamStream);
}

async function applyVirtualBgMode() {
  const mode = document.querySelector('input[name="virtualBgMode"]:checked')?.value || 'image';
  $('virtualBgCustom')?.classList.toggle('hidden', mode !== 'custom');
  if (mode === 'blur') { setSegmentationOptions({ mode: 'blur' }); return; }
  if (mode === 'custom') { setSegmentationOptions({ mode: 'image' }); return; }
  await loadDefaultBackgroundImage();
  setSegmentationOptions({ mode: 'image' });
}

async function startVirtualBg() {
  if (!isVirtualBgOn() || isPassthroughCamera(webcamStream)) return;
  await applyVirtualBgMode();
  startSegmentationLoop(webcamPip);
  if ($('virtualBgStatus')) $('virtualBgStatus').textContent = getSegmentationError() || getSegmentationStatus() || '';
}

function stopVirtualBg() {
  stopSegmentationLoop();
}

function attachWebcamPreview() {
  if (!webcamStream || !webcamToggle.checked) {
    webcamPip.classList.add('hidden');
    webcamPip.srcObject = null;
    return;
  }
  webcamPip.srcObject = webcamStream;
  webcamPip.classList.remove('hidden');
  playVideo(webcamPip);
  previewIdle?.classList.add('hidden');
}

async function openWebcam() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  const selectedId = $('camSelect')?.value || '';
  const camId = resolveDeviceId(cams, selectedId);
  if (!camId) throw new Error('Select a video device.');
  const pass = isPassthroughCamera(cams.find(d => d.deviceId === camId) || '');
  if (webcamStream && isStreamLive(webcamStream)) {
    const cur = webcamStream.getVideoTracks()[0]?.getSettings?.()?.deviceId;
    if (cur === camId) {
      syncPassthroughUi();
      attachWebcamPreview();
      updateWebcamStatus();
      return webcamStream;
    }
    webcamStream.getTracks().forEach(t => t.stop());
  }
  webcamStream = await openVideoDevice(camId, { passthrough: pass });
  localStorage.setItem('v2.webcam', camId);
  if ($('camSelect').value !== camId) $('camSelect').value = camId;
  syncPassthroughUi();
  attachWebcamPreview();
  updateWebcamStatus();
  if (isVirtualBgOn()) await startVirtualBg();
  return webcamStream;
}

function stopWebcam() {
  stopVirtualBg();
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  webcamPip.srcObject = null;
  webcamPip.classList.add('hidden');
  if (!captureCardToggle?.checked) previewIdle?.classList.remove('hidden');
}

async function openCapture() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  const devId = resolveDeviceId(cams, $('captureCardSelect')?.value || '');
  if (!devId) throw new Error('Select a video device.');
  if (captureCardStream) captureCardStream.getTracks().forEach(t => t.stop());
  captureCardStream = await openCaptureDevice(devId, { withAudio: !!$('captureCardAudio')?.checked });
  localStorage.setItem('v2.capture', devId);
  const videoOnly = new MediaStream(captureCardStream.getVideoTracks());
  captureCardPip.srcObject = videoOnly;
  captureCardPip.classList.remove('hidden');
  await playVideo(captureCardPip);
  applyCapturePos(captureCardPos);
  compositor.setCaptureEnabled(true);
  previewIdle?.classList.add('hidden');
}

function stopCapture() {
  if (captureCardStream) { captureCardStream.getTracks().forEach(t => t.stop()); captureCardStream = null; }
  captureCardPip.srcObject = null;
  captureCardPip.classList.add('hidden');
  compositor.setCaptureEnabled(false);
  if (!webcamToggle.checked) previewIdle?.classList.remove('hidden');
}

function applyWebcamPos(pos) {
  webcamPos = pos;
  webcamPip.style.left = webcamPip.style.top = webcamPip.style.right = webcamPip.style.bottom = 'auto';
  webcamPip.className = webcamPip.className.replace(/pos-\S+/g, '').trim();
  webcamPip.classList.add(`pos-${pos}`, 'webcam-pip');
}

function applyCapturePos(pos) {
  captureCardPos = pos;
  captureCardPip.style.left = captureCardPip.style.top = captureCardPip.style.right = captureCardPip.style.bottom = 'auto';
  captureCardPip.className = captureCardPip.className.replace(/pos-\S+/g, '').trim();
  captureCardPip.classList.add(`pos-${pos}`, 'capture-pip');
}

function applyWebcamSize(px) {
  webcamPip.style.width = px + 'px';
  webcamPip.style.height = px + 'px';
  if (camSizeVal) camSizeVal.textContent = px + 'px';
}

function syncCompositorPips() {
  compositor.setPipFromElement(webcamPip, previewContainer, 'webcam');
  compositor.setPipFromElement(captureCardPip, previewContainer, 'capture');
}

document.querySelectorAll('.position-buttons .pos-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const grid = btn.closest('.position-buttons');
    grid.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyWebcamPos(btn.dataset.pos);
    syncCompositorPips();
  });
});

document.querySelectorAll('#capturePosButtons .pos-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#capturePosButtons .pos-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyCapturePos(btn.dataset.pos);
    syncCompositorPips();
  });
});

camSizeSlider?.addEventListener('input', () => {
  applyWebcamSize(parseInt(camSizeSlider.value, 10));
  syncCompositorPips();
});

webcamToggle.addEventListener('change', async () => {
  webcamOptions.style.display = webcamToggle.checked ? 'flex' : 'none';
  if (webcamToggle.checked) {
    try { await openWebcam(); } catch (e) {
      alert('Webcam: ' + e.message);
      webcamToggle.checked = false;
      webcamOptions.style.display = 'none';
    }
  } else stopWebcam();
});

$('camSelect')?.addEventListener('change', async () => {
  if (webcamToggle.checked) {
    try { await openWebcam(); } catch (e) { alert(e.message); }
  }
});

captureCardToggle?.addEventListener('change', async () => {
  captureCardOptions?.classList.toggle('hidden', !captureCardToggle.checked);
  if (captureCardToggle.checked) {
    try { await openCapture(); } catch (e) {
      alert('Capture: ' + e.message);
      captureCardToggle.checked = false;
      captureCardOptions?.classList.add('hidden');
    }
  } else stopCapture();
});

$('captureCardSelect')?.addEventListener('change', async () => {
  if (captureCardToggle.checked) {
    try { await openCapture(); } catch (e) { alert(e.message); }
  }
});

$('virtualBgToggle')?.addEventListener('change', async () => {
  if ($('virtualBgToggle').checked) await startVirtualBg();
  else stopVirtualBg();
});

document.querySelectorAll('input[name="virtualBgMode"]').forEach(r => {
  r.addEventListener('change', () => applyVirtualBgMode());
});

micAudioChk?.addEventListener('change', () => {
  $('micSelectRow').style.display = micAudioChk.checked ? 'block' : 'none';
});

// ── Captions ──
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let captionCues = [];
let captionsActive = false;
let currentCaption = '';

if (!SpeechRec && $('captionsToggle')) {
  $('captionsToggle').disabled = true;
  $('captionStatus').textContent = 'Use Chrome or Edge for captions.';
}

function recordingClock() {
  let paused = totalPaused;
  if (pauseStart && mediaRecorder?.state === 'paused') paused += Date.now() - pauseStart;
  return Date.now() - startTime - paused;
}

function updateLiveCaption(text) {
  currentCaption = text || '';
  compositor.setCaption(isRecordingActive() ? currentCaption : '');
  const el = $('liveCaption');
  if (!el) return;
  if (isRecordingActive() || !text) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

function startCaptions() {
  if (!SpeechRec || !$('captionsToggle')?.checked) return;
  captionCues = [];
  captionsActive = true;
  recognition = new SpeechRec();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  recognition.onresult = e => {
    if (mediaRecorder?.state === 'paused') return;
    let interim = '';
    let interimStart = null;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0].transcript.trim();
      if (!text) continue;
      if (interimStart === null) interimStart = recordingClock();
      if (res.isFinal) {
        captionCues.push({ start: interimStart, end: recordingClock(), text });
        interimStart = null;
      } else interim += text + ' ';
    }
    updateLiveCaption(interim.trim());
  };
  recognition.onend = () => {
    if (captionsActive) setTimeout(() => { try { recognition?.start(); } catch (_) {} }, 250);
  };
  try { recognition.start(); } catch (_) {}
}

function stopCaptions() {
  captionsActive = false;
  try { recognition?.stop(); } catch (_) {}
  recognition = null;
  updateLiveCaption('');
}

// ── Record ──
recordBtn.addEventListener('click', () => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') $('recordIntentModal')?.classList.remove('hidden');
  else stopRecording();
});

$('intentCancel')?.addEventListener('click', () => $('recordIntentModal')?.classList.add('hidden'));
$('intentConfirm')?.addEventListener('click', async () => {
  $('recordIntentModal')?.classList.add('hidden');
  await startRecording();
});

pauseBtn.addEventListener('click', () => {
  if (!mediaRecorder || !supportsMediaRecorderPause()) return;
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    pauseStart = Date.now();
    setStatus('paused', 'Paused');
  } else if (mediaRecorder.state === 'paused') {
    totalPaused += Date.now() - pauseStart;
    mediaRecorder.resume();
    setStatus('recording', 'Recording');
  }
});

async function startRecording() {
  try {
    recordedChunks = [];
    previewContainer?.classList.add('is-recording');
    const sourceValue = document.querySelector('input[name="source"]:checked')?.value || 'screen';
    const audioTracks = [];

    let mainStream;
    let mainRole = 'display';
    try {
      mainStream = await navigator.mediaDevices.getDisplayMedia(
        getDisplayMediaOptions(sourceValue, $('systemAudio')?.checked),
      );
    } catch (e) {
      if (e.name === 'NotAllowedError') throw e;
      if (webcamToggle.checked && webcamStream) {
        mainStream = new MediaStream(webcamStream.getVideoTracks());
        mainRole = 'webcam';
      } else throw e;
    }

    screenStream = mainStream;
    screenStream.getAudioTracks().forEach(t => audioTracks.push(t));

    const wantCapture = captureCardToggle?.checked;
    if (wantCapture && mainRole !== 'capturecard') {
      if (!captureCardStream) await openCapture();
      captureCardStream.getAudioTracks().forEach(t => {
        if ($('captureCardAudio')?.checked) audioTracks.push(t);
      });
      compositor.setCaptureEnabled(true);
      compositor.setCaptureAsMain(false);
    } else {
      compositor.setCaptureEnabled(false);
      compositor.setCaptureAsMain(false);
    }

    if (webcamToggle.checked && mainRole !== 'webcam') {
      if (!webcamStream) await openWebcam();
      await playVideo(webcamPip);
      await waitForVideoFrame(webcamPip);
      syncCompositorPips();
      compositor.setWebcamOnCanvas(true);
      if (isVirtualBgOn()) await startVirtualBg();
    }

    if (micAudioChk?.checked) {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const capAudio = wantCapture && $('captureCardAudio')?.checked
          ? findPairedAudioDevice($('captureCardSelect')?.value, devs)?.deviceId
          : null;
        micStream = await openMicStream($('micSelect')?.value || null, capAudio ? [capAudio] : []);
        micStream.getAudioTracks().forEach(t => audioTracks.push(t));
      } catch (e) { console.warn('Mic:', e); }
    }

    screenCapture.srcObject = new MediaStream(screenStream.getVideoTracks());
    await playVideo(screenCapture);
    await waitForVideoFrame(screenCapture);

    compositor.start();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const canvasStream = composeCanvas.captureStream(canvasCaptureFps());
    const tracks = [...canvasStream.getVideoTracks()];
    (await mixAudioTracks(audioTracks)).forEach(t => tracks.push(t));
    mixedStream = new MediaStream(tracks);
    await resumeAudioContexts();

    const { recorder, mimeType } = createRecorder(mixedStream, getVideoBitrate());
    mediaRecorder = recorder;
    recordMimeType = mimeType;
    mediaRecorder.ondataavailable = e => { if (e.data?.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = onRecordStop;
    mediaRecorder.start(1000);

    startTime = Date.now();
    totalPaused = 0;
    if ($('captionsToggle')?.checked) startCaptions();
    startTimer();
    setStatus('recording', 'Recording');
    recordBtn.innerHTML = '<span class="btn-record-dot"></span> Stop Recording';
    recordBtn.classList.add('recording');
    composeCanvas.classList.remove('hidden');
    previewIdle?.classList.add('hidden');
    pauseBtn.disabled = !supportsMediaRecorderPause();

    screenStream.getVideoTracks()[0].onended = stopRecording;
  } catch (e) {
    console.error(e);
    if (e.name !== 'NotAllowedError') alert('Recording failed: ' + e.message);
    cleanup();
  }
}

function stopRecording() {
  if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
}

function onRecordStop() {
  const durationMs = Date.now() - startTime - totalPaused;
  const blob = new Blob(recordedChunks, { type: recordMimeType || 'video/webm' });
  pendingExport = { blob, durationMs, cues: [...captionCues] };
  $('exportDuration').textContent = formatTimer(durationMs);
  $('exportPreview').textContent = buildTranscript(captionCues) || '—';
  $('exportModal')?.classList.remove('hidden');
  cleanup();
}

function cleanup() {
  stopCaptions();
  compositor.stop();
  compositor.setCaption('');
  previewContainer?.classList.remove('is-recording');
  composeCanvas.classList.add('hidden');
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (mixedStream) { mixedStream.getTracks().forEach(t => t.stop()); mixedStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  screenCapture.srcObject = null;
  mediaRecorder = null;
  stopTimer();
  setStatus('ready', 'Ready');
  recordBtn.innerHTML = '<span class="btn-record-dot"></span> Start Recording';
  recordBtn.classList.remove('recording');
  pauseBtn.disabled = true;
  if (webcamToggle.checked) attachWebcamPreview();
  else if (captureCardToggle.checked) captureCardPip.classList.remove('hidden');
  else previewIdle?.classList.remove('hidden');
}

$('exportCancel')?.addEventListener('click', () => {
  $('exportModal')?.classList.add('hidden');
  pendingExport = null;
  resetSession({ captionCues, recordedChunks, clearPendingExport: () => { pendingExport = null; } });
});

$('exportConfirm')?.addEventListener('click', () => {
  if (!pendingExport) return;
  const base = `recording-${Date.now()}`;
  const ext = mimeToExtension(recordMimeType);
  const manual = $('exportManualNotes')?.value || '';
  const cues = mergeExportCues(pendingExport.cues, manual, pendingExport.durationMs);
  const meta = { basename: base, durationMs: pendingExport.durationMs, recordedAt: new Date().toISOString() };

  if ($('exportVideo')?.checked) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(pendingExport.blob);
    a.download = `${base}.${ext}`;
    a.click();
  }
  if ($('exportNotes')?.checked) downloadText(`${base}-notes.md`, buildMeetingNotes(cues, meta));
  if ($('exportVtt')?.checked) downloadText(`${base}-captions.md`, buildCaptionsMd(cues, meta));
  if ($('exportPdf')?.checked) {
    try { downloadActionPlanPdf({ cues, meta, jsPDF: window.jspdf?.jsPDF }); }
    catch (e) { alert('PDF export failed: ' + e.message); }
  }
  $('exportModal')?.classList.add('hidden');
  pendingExport = null;
  resetSession({ captionCues, recordedChunks, clearPendingExport: () => {} });
});

webcamOptions.style.display = 'none';
captureCardOptions?.classList.add('hidden');
if (isSafari || isIOS) $('safariNote')?.classList.remove('hidden');
applyWebcamPos('bottom-right');
applyWebcamSize(parseInt(camSizeSlider?.value || '320', 10));
setStatus('ready', 'Ready');
console.log('Screen2D V2', BUILD);
