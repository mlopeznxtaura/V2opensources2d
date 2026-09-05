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

export function downloadActionPlanPdf({ cues, meta = {} }) {
  const transcript = buildTranscript(cues);
  const actions = extractActionItems(transcript);
  const lines = [];
  lines.push({ text: meta.title || 'Action Plan', size: 18, bold: true });
  lines.push({ text: `Generated ${new Date().toLocaleString()}`, size: 10 });
  lines.push({ text: '', size: 10 });
  lines.push({ text: 'Next action items', size: 13, bold: true });
  if (!actions.length) {
    lines.push({
      text: transcript
        ? 'No explicit action items detected. Review the transcript and add tasks manually.'
        : 'No transcript available. Re-record with Auto Captions and microphone enabled.',
      size: 11,
    });
  } else {
    actions.forEach((item, i) => lines.push({ text: `${i + 1}. ${item}`, size: 11 }));
  }
  if (transcript) {
    lines.push({ text: '', size: 10 });
    lines.push({ text: 'Source transcript (excerpt)', size: 13, bold: true });
    const excerpt = transcript.length > 1800 ? transcript.slice(0, 1800) + '…' : transcript;
    wrapPlain(excerpt, 90).forEach(t => lines.push({ text: t, size: 10 }));
  }
  const base = meta.basename || `recording-${Date.now()}`;
  saveSimplePdf(`${base}-action-plan.pdf`, lines);
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

function wrapPlain(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars) {
      if (cur) out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

function pdfEscape(s) {
  return String(s)
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function saveSimplePdf(filename, lines) {
  const pageW = 612, pageH = 792, margin = 48;
  const pages = [];
  let y = pageH - margin;
  let page = [];
  const flush = () => { pages.push(page); page = []; y = pageH - margin; };
  for (const row of lines) {
    const size = row.size || 11;
    const chunks = wrapPlain(row.text || ' ', 92);
    for (const chunk of chunks) {
      if (y < margin + 24) flush();
      page.push(`BT /F1 ${size} Tf ${margin} ${y} Td (${pdfEscape(chunk)}) Tj ET`);
      y -= size + 5;
    }
    y -= 4;
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push(['BT /F1 11 Tf 48 720 Td (Action Plan) Tj ET']);

  const fontObjId = 3;
  let next = 4;
  const contentObjIds = pages.map(() => next++);
  const pageObjIds = pages.map(() => next++);

  let pdf = '%PDF-1.4\n';
  const off = [0];
  const emit = (n, payload) => {
    off[n] = pdf.length;
    pdf += `${n} 0 obj\n${payload}\nendobj\n`;
  };
  emit(1, '<< /Type /Catalog /Pages 2 0 R >>');
  emit(2, `<< /Type /Pages /Kids [${pageObjIds.map(n => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  emit(fontObjId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((cmds, i) => {
    const stream = cmds.join('\n');
    emit(contentObjIds[i], `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    emit(pageObjIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>`);
  });
  const xref = pdf.length;
  const count = off.length;
  pdf += `xref\n0 ${count}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < count; i++) {
    pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const blob = new Blob([pdf], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
