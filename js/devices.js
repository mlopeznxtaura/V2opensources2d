/* Device list — no blocking, no role filters. User pick always wins. */

export function resolveDeviceId(devices, selectedId) {
  const pool = devices.filter(d => d.kind === 'videoinput' && d.deviceId);
  if (selectedId && pool.some(d => d.deviceId === selectedId)) return selectedId;
  return pool[0]?.deviceId || '';
}

/** Virtual / already-processed outputs — never run in-browser background on these. */
export function isPassthroughCamera(deviceOrStream) {
  const label = typeof deviceOrStream === 'string'
    ? deviceOrStream
    : (deviceOrStream?.label || deviceOrStream?.getVideoTracks?.()?.[0]?.label || '');
  const l = label.toLowerCase();
  return /nvidia broadcast|obs virtual|virtual camera|snap camera|manycam|xsplit|mmhmm|droidcam|ecamm|voicemod|cyberlink|streamlabs virtual|elgato.*virtual/i.test(l);
}

export function videoTrackLabel(stream) {
  return stream?.getVideoTracks?.()?.[0]?.label || '';
}

export function isStreamLive(stream) {
  return !!stream?.getVideoTracks?.().some(t => t.readyState === 'live');
}
