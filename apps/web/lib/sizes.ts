// Sizes said the same way everywhere: memory in GB with the reader's decimal mark ("0,5 GB" in Turkish, "0.5 GB" in
// English), whatever page shows it. Takes next-intl's formatter (useFormatter).
type NumberFormatter = { number: (value: number, options?: { maximumFractionDigits?: number }) => string };
export const memoryGb = (format: NumberFormatter, memoryMb: number) => format.number(memoryMb / 1024, { maximumFractionDigits: 2 });
