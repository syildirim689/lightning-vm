"use client";

// Last resort when the page frame itself fails (no translations or styles can be relied on here): both languages,
// a reload, and the start page.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return <html lang="en"><body style={{ fontFamily: 'system-ui, sans-serif', display: 'grid', placeItems: 'center', minHeight: '100dvh', margin: 0, textAlign: 'center' }}>
    <div style={{ maxWidth: 420, padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>Something went wrong · Bir şeyler ters gitti</h1>
      <p style={{ color: '#666', fontSize: 14 }}>Try again, or go back to the start page. · Yeniden deneyin ya da başlangıç sayfasına dönün.</p>
      <p style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" onClick={reset} style={{ padding: '8px 14px' }}>Try again · Yeniden dene</button>
        <a href="/" style={{ padding: '8px 14px' }}>Start page · Başlangıç</a>
      </p>
    </div>
  </body></html>;
}
