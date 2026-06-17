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
