/* Stateless session — wipe all in-memory recording data after each export. */

/**
 * @param {object} state — mutable session refs from app
 */
export function resetSession(state) {
  const {
    clearPendingExport,
    captionCues,
    recordedChunks,
  } = state;

  if (typeof clearPendingExport === 'function') clearPendingExport();

  if (captionCues) captionCues.length = 0;
  if (recordedChunks) recordedChunks.length = 0;
}
