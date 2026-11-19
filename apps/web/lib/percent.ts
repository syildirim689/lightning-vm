"use client";
// A percentage the way the reader's language writes it: "20%" in English, "%20" in Turkish. Every percentage the
// panel builds itself goes through here (texts with a percentage inside have their own per language).
import { useFormatter } from 'next-intl';

// value: 0–100 (as the API gives them). digits: decimals at most. signed: "+5%" for a change.
export function usePercent() {
  const format = useFormatter();
  return (value: number, digits = 0, signed = false) => format.number(value / 100, { style: 'percent', maximumFractionDigits: digits, ...(signed && { signDisplay: 'exceptZero' as const }) });
}
