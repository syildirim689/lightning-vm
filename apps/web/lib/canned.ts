// A canned reply's placeholders: {name}, {ticket} and {server}. An unknown or empty one stays as written,
// so the agent sees what still needs filling in.
export type CannedVars = { name: string; ticket: string; server: string };
export const fillCanned = (body: string, vars: CannedVars) => body.replace(/\{(name|ticket|server)\}/g, (all, k: keyof CannedVars) => vars[k] || all);
