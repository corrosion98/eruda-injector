# Eruda Viewer frontend (Vercel)

This is the static frontend. Deploy the `frontend/` directory as a Vercel project.

Set the build-time environment variable `VITE_PROXY_BASE` to the public origin of your separately deployed proxy service, e.g. `https://your-proxy.examplehost.app`. This plain static build does not have a bundler, so replace `__PROXY_BASE__` in `public/index.html` with that URL before deployment, or use the provided deployment script.

## Quick configuration

Edit this line in `public/index.html`:

```js
const proxyBase = "__PROXY_BASE__".replace(/\/$/,"");
```

Replace `__PROXY_BASE__` with your backend URL, without a trailing slash. Commit and deploy.

In Vercel, set the project Root Directory to `frontend`, Framework Preset to Other, Build Command blank, and Output Directory `public`.
