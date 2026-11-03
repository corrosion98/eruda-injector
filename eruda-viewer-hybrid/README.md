# Eruda Viewer — Hybrid deployment

A responsive dark frontend hosted on Vercel, paired with a separate Node.js proxy backend. The backend injects Eruda into HTML and rewrites common resource URLs so CSS, JS files, images, fonts, and other GET resources can be requested through the proxy.

## Architecture

- `frontend/`: static website hosted on Vercel.
- `backend/`: Express proxy hosted on a Node.js service that supports streaming responses (for example, a private Render, Railway, or Fly.io service).
- `ALLOWED_HOSTS`: mandatory comma-separated allowlist on the backend. Never use `*`.
- `PUBLIC_PROXY_URL`: public HTTPS origin of the backend, e.g. `https://proxy.example.net`. The backend uses it to rewrite resource URLs.

## 1. Deploy the backend

Deploy the `backend/` directory to a Node.js host that supports long-running Express servers and streamed HTTP responses.

Set these environment variables:

- `ALLOWED_HOSTS=example.com,*.example.org`
- `PUBLIC_PROXY_URL=https://YOUR-BACKEND-HOST`
- `PORT` is usually supplied by the host; otherwise defaults to `8080`.
- Optional `ERUDA_URL=https://cdn.jsdelivr.net/npm/eruda`

Build/install command: `npm install`  
Start command: `npm start`

Check `https://YOUR-BACKEND-HOST/health`; it should return `{"ok":true}`.

Wildcard rules:
- `example.com` matches only the apex.
- `*.example.org` matches subdomains, not `example.org`.
- Add both entries if you need both apex and subdomains.

Only include domains you own or are authorized to inspect. Do not expose an open proxy. The allowlist is a critical security boundary.

## 2. Deploy the frontend to Vercel

1. Push this repository to GitHub.
2. Import it into Vercel.
3. Set Root Directory to `frontend`.
4. Framework Preset: Other.
5. Build Command: leave empty.
6. Output Directory: `public`.
7. In `frontend/public/index.html`, replace `__PROXY_BASE__` with your backend's HTTPS origin, e.g. `https://YOUR-BACKEND-HOST`.
8. Deploy.

## 3. Local testing

Backend:

```bash
cd backend
npm install
ALLOWED_HOSTS=example.com PUBLIC_PROXY_URL=http://localhost:8080 npm run dev
```

Frontend: replace `__PROXY_BASE__` with `http://localhost:8080`, then serve `frontend/public` with any static file server.

## Supported behavior and limitations

Implemented:
- Hostname allowlist with exact and `*.` subdomain matching.
- DNS resolution checks against common private, loopback, link-local, and reserved address ranges.
- Redirect validation against the same allowlist.
- HTML rewriting for common resource attributes, links, forms (GET only), `srcset`, inline styles, and `<style>` blocks.
- CSS rewriting for common `url(...)` and `@import` references.
- Streaming for non-HTML/non-CSS assets, including images, fonts, and many scripts/media files.
- Eruda injection into HTML responses.
- GET and HEAD only; binary resources are streamed.

Not a universal browser:
- JavaScript-generated URLs, fetch/XHR API endpoints, WebSockets, service workers, complex authentication, POST forms, some CSP/integrity cases, and site-specific routing may not work.
- The iframe intentionally omits `allow-same-origin` to isolate the preview from the viewer's origin. Some sites require normal same-origin storage/cookie behavior and may fail.
- Third-party cookies and browser privacy restrictions can affect login.
- The CDN must be reachable for Eruda to load.
- This is a starter implementation, not a formally audited SSRF defense. DNS checks alone do not fully prevent DNS rebinding between validation and connection. For public production use, add network-level egress restrictions, pinned DNS resolution at connection time, request rate limits, auth, logging, and abuse monitoring.
- The proxy does not forward upstream cookies or arbitrary request headers. Avoid using it for sensitive authenticated sessions.
- Streaming support depends on the backend host and its timeout/bandwidth limits.

Use only for domains you own or have explicit permission to debug.
