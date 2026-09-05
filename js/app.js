/* app5.nextaura.fit — strict per-feed video, no auto-pick, no shared broken patterns */

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
import { requireSelectedId, isPassthroughCamera, trackDeviceId, findPairedAudioDevice, isHdmiCaptureAudioLabel, assertDistinctVideoFeeds } from './devices.js';
import { VideoFeed, refreshDeviceLists, selectedLabel } from './streams.js';
import {
  isIOS, isSafari, supportsMediaRecorderPause, playVideo, waitForVideoFrame,
  mixAudioTracks, getDisplayMediaOptions, createRecorder, canvasCaptureFps,
  mimeToExtension, openMicStream, resumeAudioContexts, mountHiddenVideo,
  requestAudioPermission,
} from './media.js';

const BUILD = '260905-feeds';
const $ = id => document.getElementById(id);

const webcamPip = $('webcamPip');
const captureCardPip = $('captureCardPip');
const composeCanvas = $('composeCanvas');
const previewContainer = $('previewContainer');
const previewIdle = $('previewIdle');

const webcamFeed = new VideoFeed(webcamPip);
const captureFeed = new VideoFeed(captureCardPip);
const screenDecode = mountHiddenVideo('screenDecode');

const compositor = createCompositor({
  screenVideo: screenDecode,
  captureCardVideo: captureCardPip,
  webcamVideo: webcamPip,
  canvas: composeCanvas,
});

let screenStream = null;
let micStream = null;
let mixedStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordMimeType = '';
let startTime = 0;
let totalPaused = 0;
let pauseStart = 0;
let timerInterval = null;
let pendingExport = null;
let captionCues = [];
let recognition = null;
let captionsActive = false;

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function setStatus(kind, text) {
  $('statusIndicator').className = 'status-indicator ' + (kind || '');
  $('statusText').textContent = text || 'Ready';
}

function formatTimer(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function isRecording() {
  return mediaRecorder && mediaRecorder.state !== 'inactive';
}

/** Only block when the other video feed is live, or both toggles are on with the same pick. */
function conflictingVideoFeedId(opening, openingId) {
  if (opening === 'webcam') {
    if (captureFeed.deviceId) return { id: captureFeed.deviceId, label: selectedLabel($('captureCardSelect')) };
    if ($('captureCardToggle').checked) {
      const pending = $('captureCardSelect')?.value?.trim();
      if (pending && pending === openingId) {
        return { id: pending, label: selectedLabel($('captureCardSelect')) };
      }
    }
    return null;
  }
  if (webcamFeed.deviceId) return { id: webcamFeed.deviceId, label: selectedLabel($('camSelect')) };
  if ($('webcamToggle').checked) {
    const pending = $('camSelect')?.value?.trim();
    if (pending && pending === openingId) {
      return { id: pending, label: selectedLabel($('camSelect')) };
    }
  }
  return null;
}

function getCapturePos() {
  return $('capturePosButtons')?.querySelector('.active')?.dataset.pos || 'bottom-left';
}

function getBitrate() {
  const q = document.querySelector('input[name="quality"]:checked')?.value || '1080';
  if (q === '4k') return 20_000_000;
  if (q === '720') return 4_000_000;
  return 8_000_000;
}

// ── Boot: mic permission unlocks audio labels; skip video permission so default cam stays free.
async function boot() {
  await requestAudioPermission();
  await refreshDeviceLists($('camSelect'), $('captureCardSelect'), $('micSelect'));
  const savedCam = localStorage.getItem('v2.webcam');
  const savedCap = localStorage.getItem('v2.capture');
  if (savedCam && [...$('camSelect').options].some(o => o.value === savedCam)) $('camSelect').value = savedCam;
  if (savedCap && [...$('captureCardSelect').options].some(o => o.value === savedCap)) $('captureCardSelect').value = savedCap;
}
boot();
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDeviceLists($('camSelect'), $('captureCardSelect'), $('micSelect')));

function updateWebcamStatus() {
  const el = $('webcamDeviceStatus');
  if (!el || !$('webcamToggle').checked) { if (el) el.textContent = ''; return; }
  if (!webcamFeed.stream) {
    el.textContent = 'Pick a device, then enable webcam';
    return;
  }
  const wanted = selectedLabel($('camSelect'));
  const live = webcamFeed.label;
  const idOk = trackDeviceId(webcamFeed.stream) === webcamFeed.deviceId;
  el.style.color = idOk ? '' : 'var(--accent)';
  el.textContent = webcamFeed.passthrough
    ? `Live: ${live} — passthrough${idOk ? '' : ' (device id mismatch!)'}`
    : `Live: ${live}${wanted && !live.includes(wanted.split(' (')[0]) ? '' : ''}`;
}

function syncPassthroughUi() {
  const pass = webcamFeed.passthrough;
  compositor.setWebcamPassthrough(pass);
  setVirtualBgEnabled(!pass);
  const block = $('virtualBgBlock');
  if (pass) {
    stopVirtualBg();
    $('virtualBgToggle').checked = false;
    block?.classList.add('hidden');
    $('virtualBgStatus').textContent = 'Virtual cam — not edited by this app';
  } else {
    block?.classList.remove('hidden');
    $('virtualBgStatus').textContent = '';
  }
}

function isVirtualBgOn() {
  return $('webcamToggle').checked && $('virtualBgToggle')?.checked && !webcamFeed.passthrough;
}

async function startVirtualBg() {
  if (!isVirtualBgOn()) return;
  const mode = document.querySelector('input[name="virtualBgMode"]:checked')?.value || 'image';
  if (mode === 'blur') setSegmentationOptions({ mode: 'blur' });
  else { await loadDefaultBackgroundImage(); setSegmentationOptions({ mode: 'image' }); }
  startSegmentationLoop(webcamPip);
  $('virtualBgStatus').textContent = getSegmentationError() || getSegmentationStatus() || '';
}

function stopVirtualBg() { stopSegmentationLoop(); }

async function startWebcam() {
  const id = requireSelectedId($('camSelect'));
  const label = selectedLabel($('camSelect'));
  const clash = conflictingVideoFeedId('webcam', id);
  if (clash) assertDistinctVideoFeeds(id, clash.id, { camLabel: label, capLabel: clash.label });
  await webcamFeed.open(id, label);
  await refreshDeviceLists($('camSelect'), $('captureCardSelect'), $('micSelect'));
  $('camSelect').value = id;
  localStorage.setItem('v2.webcam', id);
  await suggestWebcamMic(id);
  webcamFeed.show();
  previewIdle?.classList.add('hidden');
  syncPassthroughUi();
  updateWebcamStatus();
  if (isVirtualBgOn()) await startVirtualBg();
}

async function suggestWebcamMic(videoDeviceId) {
  const sel = $('micSelect');
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mate = findPairedAudioDevice(videoDeviceId, devices);
  const status = $('micDeviceStatus');
  if (mate?.deviceId && !isHdmiCaptureAudioLabel(mate.label)) {
    if (sel && !sel.value) sel.value = mate.deviceId;
    if (status) status.textContent = `Voice mic: ${mate.label}`;
  } else if (status) {
    status.textContent = 'No microphone on this webcam — pick one in Audio, or this recording will have no voice.';
  }
}

async function resolveVoiceMicId() {
  const picked = $('micSelect')?.value?.trim();
  if (picked) return picked;
  if (!webcamFeed.deviceId) return null;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mate = findPairedAudioDevice(webcamFeed.deviceId, devices);
  if (mate?.deviceId && !isHdmiCaptureAudioLabel(mate.label)) return mate.deviceId;
  return null;
}

function stopWebcam() {
  stopVirtualBg();
  webcamFeed.stop();
  webcamFeed.hide();
  updateWebcamStatus();
  if (!captureFeed.stream) previewIdle?.classList.remove('hidden');
}

async function startCapture() {
  if (!$('webcamToggle').checked) stopWebcam();
  const id = requireSelectedId($('captureCardSelect'));
  const label = selectedLabel($('captureCardSelect'));
  const clash = conflictingVideoFeedId('capture', id);
  if (clash) assertDistinctVideoFeeds(clash.id, id, { camLabel: clash.label, capLabel: label });
  await captureFeed.open(id, label);
  if ($('captureCardAudio')?.checked) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const video = devices.find(d => d.deviceId === id);
    const mate = video?.groupId
      ? devices.find(d => d.kind === 'audioinput' && d.groupId === video.groupId)
      : null;
    if (mate?.deviceId) {
      try {
        const audio = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { ideal: mate.deviceId }, echoCancellation: false, noiseSuppression: false },
          video: false,
        });
        audio.getAudioTracks().forEach(t => captureFeed.stream.addTrack(t));
      } catch (_) {}
    }
  }
  await refreshDeviceLists($('camSelect'), $('captureCardSelect'), $('micSelect'));
  $('captureCardSelect').value = id;
  localStorage.setItem('v2.capture', id);
  captureFeed.show();
  refreshCapturePreviewLayout();
  compositor.setCaptureEnabled(true);
  previewIdle?.classList.add('hidden');
}

function stopCapture() {
  captureFeed.stop();
  captureFeed.hide();
  captureCardPip.classList.remove('capture-full-preview');
  compositor.setCaptureEnabled(false);
  compositor.setCaptureAsMain(false);
  if (!webcamFeed.stream) previewIdle?.classList.remove('hidden');
}

function applyWebcamPos(pos) {
  webcamPip.style.cssText = '';
  webcamPip.className = `webcam-pip pos-${pos}`;
}

function applyCaptureSize(px) {
  captureCardPip.style.width = px + 'px';
  $('capSizeVal').textContent = px + 'px';
}

function applyCapturePos(pos, { forcePip = false } = {}) {
  const full = !forcePip && captureFeed.stream && !isRecording();
  captureCardPip.style.cssText = '';
  if (full) {
    captureCardPip.className = 'capture-pip capture-full-preview';
    return;
  }
  captureCardPip.className = `capture-pip pos-${pos}`;
  applyCaptureSize(parseInt($('capSize')?.value || '560', 10));
}

function refreshCapturePreviewLayout() {
  applyCapturePos(getCapturePos());
  if (!captureCardPip.classList.contains('capture-full-preview')) syncCompositorPips();
}

function applyWebcamSize(px) {
  webcamPip.style.width = webcamPip.style.height = px + 'px';
  $('camSizeVal').textContent = px + 'px';
}

function syncCompositorPips() {
  compositor.setPipFromElement(webcamPip, previewContainer, 'webcam');
  compositor.setPipFromElement(captureCardPip, previewContainer, 'capture');
}

// ── UI wiring ──
$('webcamToggle').addEventListener('change', async () => {
  $('webcamOptions').style.display = $('webcamToggle').checked ? 'flex' : 'none';
  if (!$('webcamToggle').checked) { stopWebcam(); return; }
  if (!$('camSelect').value) {
    $('webcamDeviceStatus').textContent = 'Select NVIDIA Broadcast (or any cam) first, then toggle on';
    return;
  }
  try { await startWebcam(); } catch (e) {
    alert(e.message);
    $('webcamToggle').checked = false;
    $('webcamOptions').style.display = 'none';
  }
});

$('camSelect').addEventListener('change', async () => {
  if (!$('webcamToggle').checked) return;
  try { await startWebcam(); } catch (e) {
    alert(e.message);
    $('webcamToggle').checked = false;
    $('webcamOptions').style.display = 'none';
    stopWebcam();
  }
});

$('captureCardToggle').addEventListener('change', async () => {
  $('captureCardOptions').classList.toggle('hidden', !$('captureCardToggle').checked);
  if (!$('captureCardToggle').checked) { stopCapture(); return; }
  if (!$('captureCardSelect').value) return;
  try { await startCapture(); } catch (e) {
    alert(e.message);
    $('captureCardToggle').checked = false;
    $('captureCardOptions').classList.add('hidden');
  }
});

$('captureCardSelect').addEventListener('change', async () => {
  if (!$('captureCardToggle').checked) return;
  try { await startCapture(); } catch (e) {
    alert(e.message);
    $('captureCardToggle').checked = false;
    $('captureCardOptions').classList.add('hidden');
    stopCapture();
  }
});

$('virtualBgToggle')?.addEventListener('change', () => {
  if ($('virtualBgToggle').checked) startVirtualBg();
  else stopVirtualBg();
});

document.querySelectorAll('.position-buttons .pos-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.closest('.position-buttons').querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
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

$('camSize')?.addEventListener('input', () => {
  applyWebcamSize(parseInt($('camSize').value, 10));
  syncCompositorPips();
});

$('capSize')?.addEventListener('input', () => {
  if (captureCardPip.classList.contains('capture-full-preview')) return;
  applyCaptureSize(parseInt($('capSize').value, 10));
  syncCompositorPips();
});

// ── Recording ──
$('recordBtn').addEventListener('click', () => {
  if (!isRecording()) $('recordIntentModal')?.classList.remove('hidden');
  else stopRecording();
});

$('intentCancel')?.addEventListener('click', () => $('recordIntentModal')?.classList.add('hidden'));
$('intentConfirm')?.addEventListener('click', async () => {
  $('recordIntentModal')?.classList.add('hidden');
  await startRecording();
});

$('pauseBtn').addEventListener('click', () => {
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
    if (!$('webcamToggle').checked) stopWebcam();
    recordedChunks = [];
    const audioTracks = [];

    const source = document.querySelector('input[name="source"]:checked')?.value || 'screen';
    screenStream = await navigator.mediaDevices.getDisplayMedia(
      getDisplayMediaOptions(source, $('systemAudio')?.checked),
    );
    screenStream.getAudioTracks().forEach(t => audioTracks.push(t));

    screenDecode.srcObject = new MediaStream(screenStream.getVideoTracks());
    await playVideo(screenDecode);
    await waitForVideoFrame(screenDecode);

    if ($('captureCardToggle').checked) {
      if (!captureFeed.stream) await startCapture();
      applyCapturePos(getCapturePos(), { forcePip: true });
      syncCompositorPips();
      captureFeed.stream.getAudioTracks().forEach(t => {
        if ($('captureCardAudio')?.checked) audioTracks.push(t);
      });
      compositor.setCaptureEnabled(true);
      compositor.setCaptureAsMain(false);
    } else {
      compositor.setCaptureEnabled(false);
      compositor.setCaptureAsMain(false);
    }

    if ($('webcamToggle').checked) {
      if (!webcamFeed.stream) await startWebcam();
      await waitForVideoFrame(webcamPip);
      syncCompositorPips();
      compositor.setWebcamOnCanvas(true);
      if (isVirtualBgOn()) await startVirtualBg();
    }

    if ($('micAudio')?.checked) {
      const micId = await resolveVoiceMicId();
      micStream = await openMicStream(micId);
      const liveMic = micStream.getAudioTracks()[0];
      const micStatus = $('micDeviceStatus');
      if (micStatus) {
        micStatus.textContent = liveMic?.label
          ? `Recording voice: ${liveMic.label}`
          : 'Microphone opened (unnamed)';
      }
      micStream.getAudioTracks().forEach(t => audioTracks.push(t));
    }

    compositor.start();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const canvasStream = composeCanvas.captureStream(canvasCaptureFps());
    const tracks = [...canvasStream.getVideoTracks()];
    (await mixAudioTracks(audioTracks)).forEach(t => tracks.push(t));
    mixedStream = new MediaStream(tracks);
    await resumeAudioContexts();

    const { recorder, mimeType } = createRecorder(mixedStream, getBitrate());
    mediaRecorder = recorder;
    recordMimeType = mimeType;
    mediaRecorder.ondataavailable = e => { if (e.data?.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = onRecordStop;
    mediaRecorder.start(1000);

    startTime = Date.now();
    totalPaused = 0;
    if ($('captionsToggle')?.checked && SpeechRec) startCaptions();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      let p = totalPaused;
      if (pauseStart && mediaRecorder?.state === 'paused') p += Date.now() - pauseStart;
      $('timerDisplay').textContent = formatTimer(Date.now() - startTime - p);
    }, 250);

    setStatus('recording', 'Recording');
    $('recordBtn').innerHTML = '<span class="btn-record-dot"></span> Stop Recording';
    $('recordBtn').classList.add('recording');
    // Keep compose canvas hidden so screen/window capture cannot recapture it (app1 last-good).
    composeCanvas.classList.add('hidden');
    previewIdle?.classList.add('hidden');
    $('recordMirrorNote')?.classList.remove('hidden');
    $('pauseBtn').disabled = !supportsMediaRecorderPause();
    screenStream.getVideoTracks()[0].onended = stopRecording;
  } catch (e) {
    if (e.name !== 'NotAllowedError') alert('Recording failed: ' + e.message);
    cleanupAfterRecord();
  }
}

function startCaptions() {
  captionsActive = true;
  captionCues = [];
  recognition = new SpeechRec();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        captionCues.push({ start: 0, end: 0, text: e.results[i][0].transcript.trim() });
      }
    }
    compositor.setCaption(e.results[e.results.length - 1][0].transcript);
  };
  recognition.onend = () => { if (captionsActive) try { recognition.start(); } catch (_) {} };
  try { recognition.start(); } catch (_) {}
}

function stopRecording() {
  if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
}

function onRecordStop() {
  const durationMs = Date.now() - startTime - totalPaused;
  pendingExport = { blob: new Blob(recordedChunks, { type: recordMimeType }), durationMs, cues: [...captionCues] };
  $('exportDuration').textContent = formatTimer(durationMs);
  $('exportPreview').textContent = buildTranscript(captionCues) || '—';
  $('exportModal')?.classList.remove('hidden');
  cleanupAfterRecord();
}

function cleanupAfterRecord() {
  captionsActive = false;
  try { recognition?.stop(); } catch (_) {}
  compositor.stop();
  compositor.setCaption('');
  composeCanvas.classList.add('hidden');
  $('recordMirrorNote')?.classList.add('hidden');
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (mixedStream) { mixedStream.getTracks().forEach(t => t.stop()); mixedStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  screenDecode.srcObject = null;
  mediaRecorder = null;
  clearInterval(timerInterval);
  $('timerDisplay').textContent = '00:00:00';
  setStatus('ready', 'Ready');
  $('recordBtn').innerHTML = '<span class="btn-record-dot"></span> Start Recording';
  $('recordBtn').classList.remove('recording');
  $('pauseBtn').disabled = true;
  if (webcamFeed.stream) webcamFeed.show();
  if (captureFeed.stream) {
    captureFeed.show();
    refreshCapturePreviewLayout();
  }
}

$('exportCancel')?.addEventListener('click', () => {
  $('exportModal').classList.add('hidden');
  pendingExport = null;
  resetSession({ captionCues, recordedChunks, clearPendingExport: () => { pendingExport = null; } });
});

$('exportConfirm')?.addEventListener('click', () => {
  if (!pendingExport) return;
  const base = `recording-${Date.now()}`;
  const cues = mergeExportCues(pendingExport.cues, $('exportManualNotes')?.value, pendingExport.durationMs);
  const meta = { basename: base, durationMs: pendingExport.durationMs };
  if ($('exportVideo')?.checked) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(pendingExport.blob);
    a.download = `${base}.${mimeToExtension(recordMimeType)}`;
    a.click();
  }
  if ($('exportNotes')?.checked) downloadText(`${base}-notes.md`, buildMeetingNotes(cues, meta));
  if ($('exportVtt')?.checked) downloadText(`${base}-captions.md`, buildCaptionsMd(cues, meta));
  if ($('exportPdf')?.checked) downloadActionPlanPdf({ cues, meta, jsPDF: window.jspdf?.jsPDF });
  $('exportModal').classList.add('hidden');
  pendingExport = null;
  resetSession({ captionCues, recordedChunks, clearPendingExport: () => {} });
});

$('webcamOptions').style.display = 'none';
$('captureCardOptions').classList.add('hidden');
applyWebcamPos('bottom-right');
applyWebcamSize(parseInt($('camSize')?.value || '320', 10));
applyCaptureSize(parseInt($('capSize')?.value || '560', 10));
setStatus('ready', 'Ready');
console.log('Screen2D', BUILD);
