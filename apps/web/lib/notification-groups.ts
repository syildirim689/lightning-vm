// The inbox collapses a run of notifications that say the same kind of thing about the same subject (the same
// event and the same target link) into one row with a count. Plain data in, plain data out.
export type Groupable = { id: string; event: string; link: string | null; createdAt: string; readAt: string | null };
export type NotificationGroup<T extends Groupable> = {
  key: string;        // the oldest one's id: stays the same while newer ones join the run
  latest: T;          // what the row shows (the list is newest first)
  items: T[];         // every notification in the run, newest first
  unread: string[];   // ids still unread: what "mark the row read" sends
};

// `items` is newest first, as the API answers. Only neighbours are joined, so the order of the inbox is kept and
// something else in between starts a new row. A notification without a link has no subject to compare and stays
// alone. `bucket` (the day heading, say) splits a run where its value changes.
export function groupRuns<T extends Groupable>(items: T[], bucket: (item: T) => string = () => ''): NotificationGroup<T>[] {
  const groups: NotificationGroup<T>[] = [];
  for (const n of items) {
    const g = groups[groups.length - 1];
    if (g && n.link && g.latest.link === n.link && g.latest.event === n.event && bucket(g.latest) === bucket(n)) {
      g.items.push(n);
      g.key = n.id;
      if (!n.readAt) g.unread.push(n.id);
    } else groups.push({ key: n.id, latest: n, items: [n], unread: n.readAt ? [] : [n.id] });
  }
  return groups;
}
