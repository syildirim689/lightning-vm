// Undo instead of "are you sure?" for removals that can safely wait a few seconds (an SSH key, a project, a power
// schedule, a firewall's server, a canned reply): the item leaves the list at once, a message offers Undo, and the
// request is sent only when the message goes (its time ran out, it was closed, or the page is being left). Undo
// before then sends nothing. The API is asked exactly as before, so permissions, quotas, locks and the audit log are
// unchanged: the log records the removal that happened, and an undone removal never reaches the API, so it is not
// recorded at all.
// Pure (node --test lib/*.test.ts): components/undo.tsx holds the toast and the page's events.

export const UNDO_MS = 6_000;
// A message kept open (hovered, focused) still lets the removal through after this long.
export const UNDO_CAP_MS = 60_000;

export type Commit = (opts: { keepalive: boolean }) => Promise<unknown>;

export class Holder {
  private held = new Map<string, Commit>();
  // Held once: a second press on the same item while it waits does nothing.
  hold(id: string, commit: Commit): boolean {
    if (this.held.has(id)) return false;
    this.held.set(id, commit);
    return true;
  }
  // Undo: the removal is forgotten and never sent. False when it was already sent (too late to undo).
  undo(id: string): boolean { return this.held.delete(id); }
  // The message went: sent now, once. Null when it was undone or already sent.
  release(id: string, keepalive = false): Promise<unknown> | null {
    const commit = this.held.get(id);
    if (!commit) return null;
    this.held.delete(id);
    return commit({ keepalive });
  }
  // The page is being left (or closed): everything still waiting is sent, with keepalive so it survives the unload.
  releaseAll(): Promise<unknown>[] {
    return [...this.held.keys()].map((id) => this.release(id, true)).filter((p): p is Promise<unknown> => p !== null);
  }
  has(id: string) { return this.held.has(id); }
  get size() { return this.held.size; }
}
