import { NextResponse, type NextRequest } from 'next/server'

// Next.js 16 middleware (proxy). We only use it to surface the current request
// path to Server Components via a request header, so the (app) layout can
// redirect site champions (a validation-only role) away from any page other
// than Catalog Validation. Auth itself is enforced in the layout/actions.
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', request.nextUrl.pathname)
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  // Run on app routes only; skip Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
