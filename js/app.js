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
import { requireSelectedId, isPassthroughCamera, trackDeviceId, findPairedAudioDevice, isHdmiCaptureAudioLabel, assertDistinctVideoFeeds, findHdmiAudioDevice } from './devices.js';
import { VideoFeed, refreshDeviceLists, selectedLabel } from './streams.js';
import {
  isIOS, isSafari, supportsMediaRecorderPause, playVideo, waitForVideoFrame,
  mixAudioTracks, getDisplayMediaOptions, createRecorder, canvasCaptureFps,
  mimeToExtension, openMicStream, resumeAudioContexts, mountHiddenVideo,
  requestAudioPermission, openHdmiAudioStream, startHdmiAudioMonitor, stopHdmiAudioMonitor,
} from './media.js';

const BUILD = '260905-aud2';
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

let hdmiAudioStream = null;
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

/** Block only when both feeds would open the same deviceId. */
function conflictingVideoFeedId(opening, openingId) {
  if (!openingId) return null;
  if (opening === 'webcam') {
    const other = captureFeed.deviceId
      || ($('captureCardToggle').checked ? ($('captureCardSelect')?.value?.trim() || '') : '');
    if (other && other === openingId) {
      return { id: other, label: selectedLabel($('captureCardSelect')) };
    }
    return null;
  }
  const other = webcamFeed.deviceId
    || ($('webcamToggle').checked ? ($('camSelect')?.value?.trim() || '') : '');
  if (other && other === openingId) {
    return { id: other, label: selectedLabel($('camSelect')) };
  }
  return null;
}

function captureInUseId() {
  return captureFeed.deviceId || ($('captureCardToggle').checked ? ($('captureCardSelect')?.value?.trim() || '') : '');
}

function pickWebcamDeviceId() {
  const taken = captureInUseId();
  const opts = [...($('camSelect')?.options || [])].filter(o => o.value);
  const prefer = opts.find(o => /usb camera|link camera|webcam|integrated|hd camera/i.test(o.text) && o.value !== taken);
  if (prefer) return prefer.value;
  return opts.find(o => o.value !== taken)?.value || '';
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
  if (savedCap && [...$('captureCardSelect').options].some(o => o.value === savedCap)) $('captureCardSelect').value = savedCap;
  if (savedCam && savedCam !== savedCap && [...$('camSelect').options].some(o => o.value === savedCam)) {
    $('camSelect').value = savedCam;
  }
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
  let id = $('camSelect')?.value?.trim() || '';
  if (!id || conflictingVideoFeedId('webcam', id)) {
    id = pickWebcamDeviceId();
    if (id) $('camSelect').value = id;
  }
  if (!id) {
    const status = $('webcamDeviceStatus');
    if (status) status.textContent = 'Pick your USB webcam in the list — not the NearStream capture card.';
    return;
  }
  const label = selectedLabel($('camSelect'));
  const clash = conflictingVideoFeedId('webcam', id);
  if (clash) {
    const status = $('webcamDeviceStatus');
    if (status) status.textContent = `That device is already Feed 1 (${clash.label}). Pick USB CAMERA.`;
    return;
  }
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
  stopHdmiAudioMonitor();
  hdmiAudioStream = null;

  const audioStatus = $('captureCardAudioStatus');
  let hdmiAudioId = false;
  if ($('captureCardAudio')?.checked) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    hdmiAudioId = findHdmiAudioDevice(id, devices)?.deviceId || true;
  }
  await captureFeed.open(id, label, { audio: hdmiAudioId });

  const liveHdmi = (captureFeed.stream?.getAudioTracks() || []).filter(t => t.readyState === 'live');
  if (liveHdmi.length) {
    hdmiAudioStream = new MediaStream(liveHdmi);
    const heard = await startHdmiAudioMonitor(hdmiAudioStream);
    const name = liveHdmi[0].label || 'HDMI audio';
    if (audioStatus) {
      audioStatus.textContent = heard
        ? `HDMI audio live: ${name}`
        : `HDMI audio captured: ${name} — click the page if you still can’t hear preview`;
    }
  } else if ($('captureCardAudio')?.checked) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mate = findHdmiAudioDevice(id, devices);
    if (mate?.deviceId) {
      try {
        hdmiAudioStream = await openHdmiAudioStream(mate.deviceId);
        const heard = await startHdmiAudioMonitor(hdmiAudioStream);
        if (audioStatus) {
          audioStatus.textContent = heard
            ? `HDMI audio live: ${mate.label}`
            : `HDMI audio captured: ${mate.label} — click the page if you still can’t hear preview`;
        }
      } catch (err) {
        if (audioStatus) audioStatus.textContent = `Could not open HDMI audio (${mate.label}): ${err.message}`;
      }
    } else if (audioStatus) {
      audioStatus.textContent = 'No HDMI audio device found (look for NearStream / Digital Audio). Voice mic is separate.';
    }
  } else if (audioStatus) {
    audioStatus.textContent = '';
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
  stopHdmiAudioMonitor();
  if (hdmiAudioStream) { hdmiAudioStream.getTracks().forEach(t => t.stop()); hdmiAudioStream = null; }
  captureCardPip.muted = true;
  captureCardPip.dataset.hear = '';
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

function wantsHdmiMain() {
  return document.querySelector('input[name="source"]:checked')?.value === 'hdmi';
}

function applyCapturePos(pos, { forcePip = false } = {}) {
  const full = !forcePip && captureFeed.stream && (!isRecording() || wantsHdmiMain());
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
  try { await startWebcam(); } catch (e) {
    $('webcamDeviceStatus').textContent = e.message;
  }
});

$('camSelect').addEventListener('change', async () => {
  if (!$('webcamToggle').checked) return;
  try { await startWebcam(); } catch (e) {
    $('webcamDeviceStatus').textContent = e.message;
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

let dragging = false, dragOffX = 0, dragOffY = 0, dragTarget = null;

function startPipDrag(e, el) {
  if (el === captureCardPip && el.classList.contains('capture-full-preview')) return;
  dragging = true;
  dragTarget = el;
  const rect = el.getBoundingClientRect();
  dragOffX = e.clientX - rect.left;
  dragOffY = e.clientY - rect.top;
  el.style.transition = 'none';
  e.preventDefault();
}

webcamPip.addEventListener('mousedown', e => startPipDrag(e, webcamPip));
captureCardPip.addEventListener('mousedown', e => startPipDrag(e, captureCardPip));
webcamPip.addEventListener('touchstart', e => {
  if (!e.touches?.[0]) return;
  const t = e.touches[0];
  startPipDrag({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() }, webcamPip);
}, { passive: false });

document.addEventListener('mousemove', e => {
  if (!dragging || !dragTarget) return;
  const container = previewContainer.getBoundingClientRect();
  const w = dragTarget.offsetWidth || 320;
  const h = dragTarget.offsetHeight || 320;
  let x = e.clientX - container.left - dragOffX;
  let y = e.clientY - container.top - dragOffY;
  x = Math.max(0, Math.min(x, container.width - w));
  y = Math.max(0, Math.min(y, container.height - h));
  dragTarget.style.left = x + 'px';
  dragTarget.style.top = y + 'px';
  dragTarget.style.right = 'auto';
  dragTarget.style.bottom = 'auto';
  syncCompositorPips();
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (dragTarget) dragTarget.style.transition = '';
  dragTarget = null;
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
    const hdmiMain = source === 'hdmi';

    if (hdmiMain) {
      if (!$('captureCardToggle').checked) {
        throw new Error('Enable Feed 1 (HDMI / capture card) first, or pick Screen / Window / Tab.');
      }
      if (!captureFeed.stream) await startCapture();
      await waitForVideoFrame(captureCardPip);
      applyCapturePos(getCapturePos());
      compositor.setCaptureAsMain(true);
      compositor.setCaptureEnabled(false);
      captureFeed.stream.getAudioTracks().forEach(t => {
        if ($('captureCardAudio')?.checked) { t.enabled = true; audioTracks.push(t); }
      });
      if (hdmiAudioStream) {
        hdmiAudioStream.getAudioTracks().forEach(t => {
          if ($('captureCardAudio')?.checked && !audioTracks.includes(t)) {
            t.enabled = true;
            audioTracks.push(t);
          }
        });
      }
    } else {
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
          if ($('captureCardAudio')?.checked) { t.enabled = true; audioTracks.push(t); }
        });
        if (hdmiAudioStream) {
          hdmiAudioStream.getAudioTracks().forEach(t => {
            if ($('captureCardAudio')?.checked && !audioTracks.includes(t)) {
              t.enabled = true;
              audioTracks.push(t);
            }
          });
        }
        compositor.setCaptureEnabled(true);
        compositor.setCaptureAsMain(false);
      } else {
        compositor.setCaptureEnabled(false);
        compositor.setCaptureAsMain(false);
      }
    }

    if ($('webcamToggle').checked) {
      if (!webcamFeed.stream) await startWebcam();
      if (webcamFeed.stream) {
        await waitForVideoFrame(webcamPip);
        syncCompositorPips();
        compositor.setWebcamOnCanvas(true);
        if (isVirtualBgOn()) await startVirtualBg();
      }
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

    stopHdmiAudioMonitor();
    const canvasStream = composeCanvas.captureStream(canvasCaptureFps());
    const tracks = [...canvasStream.getVideoTracks()];
    const mixedAudio = await mixAudioTracks(audioTracks);
    mixedAudio.forEach(t => tracks.push(t));
    mixedStream = new MediaStream(tracks);
    if (mixedAudio.length) await startHdmiAudioMonitor(new MediaStream(mixedAudio));

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
    composeCanvas.classList.add('hidden');
    previewIdle?.classList.add('hidden');
    if (hdmiMain) $('recordMirrorNote')?.classList.add('hidden');
    else $('recordMirrorNote')?.classList.remove('hidden');
    $('pauseBtn').disabled = !supportsMediaRecorderPause();
    if (screenStream?.getVideoTracks()[0]) screenStream.getVideoTracks()[0].onended = stopRecording;
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
  compositor.setCaptureAsMain(false);
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

document.addEventListener('click', () => { resumeAudioContexts(); if (hdmiAudioStream) startHdmiAudioMonitor(hdmiAudioStream); }, { once: true });
$('webcamOptions').style.display = 'none';
$('captureCardOptions').classList.add('hidden');
applyWebcamPos('bottom-right');
applyWebcamSize(parseInt($('camSize')?.value || '240', 10));
applyCaptureSize(parseInt($('capSize')?.value || '560', 10));
setStatus('ready', 'Ready');
console.log('Screen2D', BUILD);
