/* Meeting notes + action-plan PDF from voice transcript */

const ACTION_PATTERNS = [
  /\b(?:action item|todo|to-do|next step|follow[- ]?up|we need to|i need to|you need to|let'?s|should|must|will)\b[^.!?]{0,120}[.!?]?/gi,
  /\b(?:assign(?:ed)?|due|deadline|by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week))\b[^.!?]{0,100}[.!?]?/gi,
  /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+.{8,200}/g,
];

export function buildTranscript(cues) {
  if (!cues || !cues.length) return '';
  return cues.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
}

/** Turn typed export notes into pseudo-cues for notes/PDF/VTT. */
export function cuesFromManualText(text, durationMs = 60000) {
  const raw = (text || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const end = Math.max(durationMs, 1000);
  if (lines.length <= 1) {
    return [{ start: 0, end, text: lines[0] || raw }];
  }
  const step = end / lines.length;
  return lines.map((line, i) => ({
    start: Math.round(i * step),
    end: Math.round((i + 1) * step),
    text: line,
  }));
}

export function mergeExportCues(speechCues, manualText, durationMs) {
  const speech = speechCues?.length ? [...speechCues] : [];
  const manual = cuesFromManualText(manualText, durationMs);
  if (!speech.length) return manual;
  if (!manual.length) return speech;
  const offset = speech[speech.length - 1].end + 500;
  return [
    ...speech,
    ...manual.map(c => ({
      start: c.start + offset,
      end: c.end + offset,
      text: c.text,
    })),
  ];
}

export function buildMeetingNotes(cues, meta = {}) {
  const title = meta.title || 'Meeting Notes';
  const when = meta.recordedAt || new Date().toISOString();
  const duration = meta.durationMs ? formatDuration(meta.durationMs) : '—';
  const lines = [
    `# ${title}`,
    '',
    `**Recorded:** ${when}`,
    `**Duration:** ${duration}`,
    '',
    '## Transcript',
    '',
  ];

  if (!cues || !cues.length) {
    lines.push('_No speech captured. Enable Auto Captions and microphone during recording._');
  } else {
    cues.forEach(c => {
      lines.push(`**[${formatTs(c.start)}]** ${c.text}`);
    });
  }

  const transcript = buildTranscript(cues);
  const actions = extractActionItems(transcript);
  lines.push('', '## Summary', '');
  if (transcript) {
    lines.push(transcript.length > 500 ? transcript.slice(0, 500) + '…' : transcript);
  } else {
    lines.push('_No summary available._');
  }

  if (actions.length) {
    lines.push('', '## Suggested action items', '');
    actions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }

  return lines.join('\n');
}

export function extractActionItems(transcript) {
  if (!transcript) return [];
  const found = new Set();
  for (const pat of ACTION_PATTERNS) {
    const matches = transcript.match(pat) || [];
    matches.forEach(m => {
      const clean = m.replace(/^[\s\-*•\d.)]+/, '').trim();
      if (clean.length >= 12 && clean.length <= 220) found.add(clean);
    });
  }
  return [...found].slice(0, 12);
}

export function downloadText(filename, content, mime = 'text/markdown') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadActionPlanPdf({ cues, meta = {}, jsPDF }) {
  if (!jsPDF) throw new Error('jsPDF not loaded');
  const transcript = buildTranscript(cues);
  const actions = extractActionItems(transcript);
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 48;
  let y = margin;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(meta.title || 'Action Plan', margin, y);
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Generated ${new Date().toLocaleString()}`, margin, y);
  y += 24;
  doc.setTextColor(0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Next action items', margin, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);

  if (!actions.length) {
    const msg = transcript
      ? 'No explicit action items detected. Review transcript below and add tasks manually.'
      : 'No transcript available. Re-record with Auto Captions and microphone enabled.';
    const wrapped = doc.splitTextToSize(msg, 516);
    doc.text(wrapped, margin, y);
    y += wrapped.length * 14 + 16;
  } else {
    actions.forEach((item, i) => {
      const line = `${i + 1}. ${item}`;
      const wrapped = doc.splitTextToSize(line, 516);
      if (y + wrapped.length * 14 > 720) {
        doc.addPage();
        y = margin;
      }
      doc.text(wrapped, margin, y);
      y += wrapped.length * 14 + 8;
    });
  }

  if (transcript) {
    if (y > 600) { doc.addPage(); y = margin; }
    y += 12;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Source transcript (excerpt)', margin, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const excerpt = transcript.length > 1200 ? transcript.slice(0, 1200) + '…' : transcript;
    doc.splitTextToSize(excerpt, 516).forEach(line => {
      if (y > 720) { doc.addPage(); y = margin; }
      doc.text(line, margin, y);
      y += 13;
    });
  }

  const base = meta.basename || `recording-${Date.now()}`;
  doc.save(`${base}-action-plan.pdf`);
}

export function buildCaptionsMd(cues, meta = {}) {
  const title = meta.title || 'Captions';
  const lines = [`# ${title}`, ''];
  if (!cues?.length) {
    lines.push('_No speech captured._');
    return lines.join('\n');
  }
  cues.forEach(c => {
    lines.push(`**[${formatTs(c.start)}]** ${c.text}`);
  });
  return lines.join('\n');
}

export function buildVttFromCues(cues) {
  let out = 'WEBVTT\n\n';
  cues.forEach((c, i) => {
    const end = Math.max(c.end, c.start + 500);
    out += `${i + 1}\n${vttTimestamp(c.start)} --> ${vttTimestamp(end)}\n${c.text}\n\n`;
  });
  return out;
}

function vttTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms));
  const h  = Math.floor(total / 3600000);
  const m  = Math.floor((total % 3600000) / 60000);
  const s  = Math.floor((total % 60000) / 1000);
  const ms3 = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms3).padStart(3, '0')}`;
}

function formatTs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}
