// pdfmake 0.3 ships no types; only what lib/api-pdf.ts uses.
declare module 'pdfmake/build/pdfmake' {
  type Pdf = { addVirtualFileSystem(vfs: unknown): void; createPdf(doc: unknown): { download(name?: string): Promise<void> } };
  const pdfMake: Pdf & { default?: Pdf };
  export default pdfMake;
}
declare module 'pdfmake/build/vfs_fonts' {
  const vfs: Record<string, string> & { default?: Record<string, string> };
  export default vfs;
}
