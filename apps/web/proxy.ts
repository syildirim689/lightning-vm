import { NextResponse, type NextRequest } from 'next/server';

// Tells the panel layout which page was asked for, so a signed-out visitor is sent to /login?next=<that page>
// and comes back to it after signing in (lib/back-to.ts). Nothing else is changed.
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-lvm-path', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!api/|_next/|.*\\..*).*)'] };
