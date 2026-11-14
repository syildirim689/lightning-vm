"use client";
// Long messages typed into the panel are kept in this browser until they are sent, so a closed tab, a reload or a
// slip of the hand loses nothing. Signing out removes them (a shared computer keeps no one's half-written text).
const prefix = 'lvm:draft:';
// Support tickets keep their own drafts under these keys (app/(panel)/support).
const older = ['lvm:support-draft:', 'lvm:support-new-draft'];

export function readDraft(key: string): string {
  try { return localStorage.getItem(prefix + key) ?? ''; } catch { return ''; }
}
export function writeDraft(key: string, text: string) {
  try { if (text.trim()) localStorage.setItem(prefix + key, text); else localStorage.removeItem(prefix + key); } catch { /* storage blocked */ }
}
export function clearDrafts() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(prefix) || older.some((o) => k.startsWith(o))) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
}
