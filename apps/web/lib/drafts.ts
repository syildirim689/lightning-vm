"use client";
// Long messages typed into the panel are kept in this browser until they are sent, so a closed tab, a reload or a
// slip of the hand loses nothing. The end of the session removes them, a sign-out or one that ran out alike (a shared
// computer keeps no one's half-written text for the next account): lib/session-end.ts lists this prefix, and the
// support tickets' own draft keys (app/(panel)/support), among the content it removes.
const prefix = 'lvm:draft:';

export function readDraft(key: string): string {
  try { return localStorage.getItem(prefix + key) ?? ''; } catch { return ''; }
}
export function writeDraft(key: string, text: string) {
  try { if (text.trim()) localStorage.setItem(prefix + key, text); else localStorage.removeItem(prefix + key); } catch { /* storage blocked */ }
}
