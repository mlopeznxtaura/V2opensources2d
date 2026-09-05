/* Strict device identity — no auto-pick, no fallback to default camera. */

export function isPassthroughCamera(deviceOrStream) {
  const label = typeof deviceOrStream === 'string'
    ? deviceOrStream
    : (deviceOrStream?.label || deviceOrStream?.getVideoTracks?.()?.[0]?.label || '');
  return /nvidia broadcast|obs virtual|virtual camera|snap camera|manycam|xsplit|mmhmm|droidcam|ecamm|voicemod|cyberlink|streamlabs virtual|elgato.*virtual/i.test(label.toLowerCase());
}

export function videoTrackLabel(stream) {
  return stream?.getVideoTracks?.()?.[0]?.label || '';
}

export function trackDeviceId(stream) {
  return stream?.getVideoTracks?.()?.[0]?.getSettings?.()?.deviceId || '';
}

export function isStreamLive(stream) {
  return !!stream?.getVideoTracks?.().some(t => t.readyState === 'live');
}

/** Must have an explicit dropdown selection — never substitute another device. */
export function requireSelectedId(selectEl) {
  const id = selectEl?.value?.trim();
  if (!id) throw new Error('Pick a device from the list first.');
  return id;
}

export function assertDistinctVideoFeeds(camId, capId, { camLabel = '', capLabel = '' } = {}) {
  if (!camId || !capId || camId !== capId) return;
  const cam = camLabel || 'webcam';
  const cap = capLabel || 'capture card';
  throw new Error(`"${cam}" and "${cap}" are the same video device. Pick a different one in Feed 1 or Feed 2.`);
}

export function formatVideoOpenError(err, label = 'That camera') {
  const msg = err?.message || '';
  if (err?.name === 'NotReadableError' || /in use|busy|allocate/i.test(msg)) {
    return new Error(`${label} is in use. Close OBS, Windows Camera, or the other feed in this app, then try again.`);
  }
  if (err?.name === 'NotFoundError') {
    return new Error(`${label} was not found. Unplug/replug it or pick another device.`);
  }
  return err instanceof Error ? err : new Error(msg || 'Could not open that device.');
}

/** After getUserMedia, confirm we got the device the user asked for. */
export function assertOpenedDevice(stream, expectedDeviceId) {
  const track = stream?.getVideoTracks?.()?.[0];
  if (!track) throw new Error('No video track returned.');
  const actual = track.getSettings?.()?.deviceId;
  if (expectedDeviceId && actual && actual !== expectedDeviceId) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error(`Browser opened a different device (${track.label || 'unknown'}). Try again or close other apps using the camera.`);
  }
  return stream;
}

export function isHdmiCaptureAudioLabel(label) {
  const l = (label || '').toLowerCase();
  return /digital audio|hdmi|capture|line in|interface|ccd10|nearstream|gc3101/.test(l)
    && !/webcam|microphone array|headset|usb camera|link camera/.test(l);
}

export function findHdmiAudioDevice(videoDeviceId, devices) {
  const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
  const hdmiLike = audioInputs.filter(d => isHdmiCaptureAudioLabel(d.label));
  const video = devices.find(d => d.deviceId === videoDeviceId && d.kind === 'videoinput');

  const usbMatch = video?.label.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i);
  if (usbMatch) {
    const mate = hdmiLike.find(a => a.label.toLowerCase().includes(usbMatch[1].toLowerCase()));
    if (mate) return mate;
  }
  const stem = (video?.label || '').split('(')[0].trim().toLowerCase();
  if (stem.length > 2) {
    const mate = hdmiLike.find(a => a.label.toLowerCase().includes(stem));
    if (mate) return mate;
  }
  const paired = findPairedAudioDevice(videoDeviceId, devices);
  if (paired && isHdmiCaptureAudioLabel(paired.label)) return paired;
  return hdmiLike[0] || null;
}

/** Pair a camera/capture-card video device to its sibling microphone (groupId, USB id, or name). */
export function findPairedAudioDevice(videoDeviceId, devices) {
  const video = devices.find(d => d.deviceId === videoDeviceId && d.kind === 'videoinput');
  if (!video) return null;
  const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
  if (!audioInputs.length) return null;

  if (video.groupId) {
    const mate = audioInputs.find(d => d.groupId === video.groupId);
    if (mate) return mate;
  }

  const usbMatch = video.label.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i);
  if (usbMatch) {
    const mate = audioInputs.find(a => a.label.toLowerCase().includes(usbMatch[1].toLowerCase()));
    if (mate) return mate;
  }

  const stem = video.label.split('(')[0].trim().toLowerCase();
  if (stem.length > 2) {
    const mate = audioInputs.find(a => a.label.toLowerCase().includes(stem));
    if (mate) return mate;
  }
  return null;
}
