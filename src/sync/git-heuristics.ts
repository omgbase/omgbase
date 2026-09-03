// Git-related heuristics (01 §6, 07 task 7.1). Conflict-marker detection flags a
// document `conflicted` (mutations refused until clean); whole-file hash match
// against a deleted/moved document detects a rename. These are hints layered on
// the checkpoint model — a checkout arrives as one large checkpoint that
// hash-locking makes cheap.

// Git conflict markers: <<<<<<< … ======= … >>>>>>> at line starts.
export function hasConflictMarkers(content: string): boolean {
  // Require both an opening and a closing marker to avoid false positives on
  // prose that happens to start a line with '======='.
  return /^<{7}/m.test(content) && /^>{7}/m.test(content);
}

// Rename detection: a new-path file whose whole-file hash equals a known
// deleted document's last file_hash is that document moved (01 §6). Returns the
// doc id to re-path, or null.
export interface RenameCandidate {
  docId: string;
  fileHashHex: string;
}

export function detectRename(newFileHashHex: string, deletedCandidates: RenameCandidate[]): string | null {
  const match = deletedCandidates.find((c) => c.fileHashHex === newFileHashHex);
  return match ? match.docId : null;
}
