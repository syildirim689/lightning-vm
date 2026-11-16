// Search as people type it: "sirket" finds "Şirket", "istanbul" finds "Istanbul" and "ISTANBUL", whatever the
// panel's language is (fold lives in note-line.ts, which the node tests load).
import { fold } from './note-line';
export { fold };
// For lists that filter while typing (ComboBox defaultFilter).
export const matches = (text: string, typed: string) => fold(text).includes(fold(typed));
