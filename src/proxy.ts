import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Next 16 renamed `middleware.ts` to `proxy.ts`. With a `src/` layout it must
 * live at `src/proxy.ts`, as a sibling of `src/app/`.
 *
 * Deliberately bare. Clerk 7 deprecated `createRouteMatcher` and now warns
 * against gating auth here at all: Server Functions are dispatched as POSTs to
 * whatever route they're used on, so a path-based matcher can be bypassed and
 * regex/route drift silently opens holes. Real authorization lives in
 * requireLeagueMembership(), called by every page, action and route handler.
 *
 * This exists only so `auth()` has a request context to read.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Everything except static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    // Required by Clerk 7 for its own handshake routes.
    "/__clerk/(.*)",
  ],
};
