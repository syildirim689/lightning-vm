"use client";
// Sizes shown the same way everywhere, in the person's number format: bytes ("1,5 GB") and memory given in MB
// ("512 MB", "2 GB", "1,5 GB"). Binary units (1024), as VMware and the order page count them.
import { useFormatter } from 'next-intl';

const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function useUnits() {
  const format = useFormatter();
  const bytes = (n: number | null | undefined) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '–';
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${format.number(v, { maximumFractionDigits: i >= 3 ? 2 : i ? 1 : 0 })} ${units[i]}`;
  };
  const memory = (mb: number | null | undefined) => (mb === null || mb === undefined ? '–'
    : mb < 1024 ? `${format.number(mb)} MB` : `${format.number(mb / 1024, { maximumFractionDigits: 2 })} GB`);
  return { bytes, memory };
}
