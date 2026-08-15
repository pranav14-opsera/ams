// WO-028: CSP directives tuned for the platform's Next.js SPA
// (shadcn/ui's inline-styled components, Next's hydration scripts) and
// its WebSocket connections (real-time agent trace streaming) — applied
// here, on the backend API responses, as defense-in-depth alongside
// whatever the Next.js frontend's own `next.config` CSP (not part of
// this backend repo) sets on the HTML document itself. A JSON API
// response has little use for a CSP in practice, but this WO's own
// acceptance criteria require it on every response regardless.
export const CONTENT_SECURITY_POLICY_DIRECTIVES = {
  defaultSrc: ["'self'"],
  // Next.js's production hydration script tags carry a nonce in a
  // properly configured deployment; 'unsafe-inline' here is the
  // documented fallback this platform's Next.js frontend actually needs
  // until nonce-based CSP is wired through Next's own middleware (a
  // frontend-repo concern, not this backend's).
  scriptSrc: ["'self'", "'unsafe-inline'"],
  // shadcn/ui (Radix primitives + Tailwind) injects inline style
  // attributes at runtime — 'unsafe-inline' is required for the UI to
  // render at all, not an oversight.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "https:"],
  fontSrc: ["'self'", "data:"],
  // wss:/https: — the platform's real-time agent trace/session streams
  // (WebSocket) plus normal API calls.
  connectSrc: ["'self'", "wss:", "https:"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
} as const;
