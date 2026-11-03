import express from "express";
import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 8080);
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_CSS_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const ERUDA_URL = process.env.ERUDA_URL || "https://cdn.jsdelivr.net/npm/eruda";

function hostAllowed(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const rules = (process.env.ALLOWED_HOSTS || "")
    .split(",").map(v => v.trim().toLowerCase()).filter(Boolean);

  return rules.some(rule => {
    const pattern = rule.replace(/\.$/, "");
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      return host.endsWith(suffix) && host !== pattern.slice(2);
    }
    return host === pattern;
  });
}

function isPrivateIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a,b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (family === 6) {
    const ip = address.toLowerCase();
    return ip === "::" || ip === "::1" ||
      ip.startsWith("fc") || ip.startsWith("fd") ||
      ip.startsWith("fe80:") ||
      ip.startsWith("::ffff:127.") ||
      ip.startsWith("::ffff:10.") ||
      ip.startsWith("::ffff:192.168.");
  }
  return true;
}

async function validateUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS destinations are supported.");
  }
  if (url.username || url.password) throw new Error("URL credentials are not allowed.");
  if (!hostAllowed(url.hostname)) throw new Error(`Host not authorized: ${url.hostname}`);

  // Reject IP literals and hostnames resolving to non-public addresses.
  if (net.isIP(url.hostname)) throw new Error("IP-literal destinations are blocked.");
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateIp(record.address))) {
    throw new Error("Destination resolves to a blocked network address.");
  }
  return url;
}

function proxyHref(targetUrl) {
  const base = process.env.PUBLIC_PROXY_URL;
  if (!base) throw new Error("PUBLIC_PROXY_URL is not configured.");
  const encoded = encodeURIComponent(targetUrl);
  return `${base.replace(/\/$/, "")}/proxy?url=${encoded}`;
}

function shouldSkipUrl(value) {
  return !value || /^(?:data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(value.trim());
}

function rewriteCss(css, baseUrl) {
  // Handles the common CSS url(...) and @import patterns, not every CSS grammar edge case.
  let out = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, raw) => {
    const value = raw.trim();
    if (shouldSkipUrl(value)) return match;
    try { return `url("${proxyHref(new URL(value, baseUrl).href)}")`; }
    catch { return match; }
  });

  out = out.replace(/@import\s+(?:url\()?(['"])(.*?)\1\)?/gi, (match, quote, raw) => {
    try { return `@import url("${proxyHref(new URL(raw, baseUrl).href)}")`; }
    catch { return match; }
  });
  return out;
}

function rewriteSrcset(value, baseUrl) {
  return value.split(",").map(candidate => {
    const parts = candidate.trim().split(/\s+/);
    if (!parts[0] || shouldSkipUrl(parts[0])) return candidate;
    try { parts[0] = proxyHref(new URL(parts[0], baseUrl).href); } catch {}
    return parts.join(" ");
  }).join(", ");
}

function transformHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });
  $("base").remove();

  const resourceAttrs = [
    ["script", "src"], ["img", "src"], ["source", "src"],
    ["video", "src"], ["audio", "src"], ["track", "src"],
    ["iframe", "src"], ["embed", "src"], ["object", "data"],
    ["link", "href"], ["input", "src"]
  ];

  for (const [tag, attr] of resourceAttrs) {
    $(`${tag}[${attr}]`).each((_, element) => {
      const value = $(element).attr(attr);
      if (shouldSkipUrl(value)) return;
      try { $(element).attr(attr, proxyHref(new URL(value, baseUrl).href)); } catch {}
    });
  }

  // Navigation and form actions remain inside the proxy. Form methods are not
  // forwarded by this starter; GET form actions can work, POST is intentionally unsupported.
  $("a[href], area[href]").each((_, element) => {
    const value = $(element).attr("href");
    if (shouldSkipUrl(value)) return;
    try { $(element).attr("href", proxyHref(new URL(value, baseUrl).href)); } catch {}
    $(element).removeAttr("target");
  });

  $("form").each((_, element) => {
    const action = $(element).attr("action") || baseUrl;
    try { $(element).attr("action", proxyHref(new URL(action, baseUrl).href)); } catch {}
    const method = ($(element).attr("method") || "get").toLowerCase();
    if (method !== "get") $(element).attr("onsubmit", "return false");
  });

  $("[srcset]").each((_, element) => {
    $(element).attr("srcset", rewriteSrcset($(element).attr("srcset"), baseUrl));
  });
  $("[style]").each((_, element) => {
    $(element).attr("style", rewriteCss($(element).attr("style"), baseUrl));
  });
  $("style").each((_, element) => {
    $(element).text(rewriteCss($(element).text(), baseUrl));
  });

  // Keep script execution in the isolated preview. Dynamic URLs created by JS
  // cannot be reliably rewritten by static HTML transformation.
  const injection = `
<script src="${ERUDA_URL}"></script>
<script>
window.addEventListener("load", function () {
  if (window.eruda) {
    window.eruda.init({ defaults: { displaySize: 48, transparency: 0.9 } });
    window.eruda.show();
  }
});
</script>`;

  if ($("head").length) $("head").append(injection);
  else $.root().prepend(`<head>${injection}</head>`);

  return $.html();
}

function sendError(res, status, message) {
  return res.status(status).type("text/plain").send(message);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.all("/proxy", async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.setHeader("Allow", "GET, HEAD");
    return sendError(res, 405, "Only GET and HEAD are supported by this proxy.");
  }

  const raw = typeof req.query.url === "string" ? req.query.url : "";
  if (!raw) return sendError(res, 400, "Missing url parameter.");

  let target;
  try {
    target = await validateUrl(raw);
  } catch (error) {
    return sendError(res, 403, error.message);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": "ErudaViewer/1.0",
        "accept": req.get("accept") || "*/*",
        ...(req.get("range") ? { "range": req.get("range") } : {})
      }
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (!location) return sendError(res, 502, "Upstream redirect missing Location.");
      const next = new URL(location, target);
      try { await validateUrl(next.href); }
      catch (error) { return sendError(res, 403, `Redirect blocked: ${error.message}`); }
      return res.redirect(302, proxyHref(next.href));
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    for (const name of ["content-range", "accept-ranges", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    if (req.method === "HEAD") return res.end();

    if (contentType.includes("text/html")) {
      const declared = Number(upstream.headers.get("content-length") || 0);
      if (declared > MAX_HTML_BYTES) return sendError(res, 413, "HTML document exceeds size limit.");
      const body = await upstream.text();
      if (Buffer.byteLength(body) > MAX_HTML_BYTES) return sendError(res, 413, "HTML document exceeds size limit.");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(transformHtml(body, target));
    }

    if (contentType.includes("text/css")) {
      const declared = Number(upstream.headers.get("content-length") || 0);
      if (declared > MAX_CSS_BYTES) return sendError(res, 413, "CSS stylesheet exceeds size limit.");
      const body = await upstream.text();
      if (Buffer.byteLength(body) > MAX_CSS_BYTES) return sendError(res, 413, "CSS stylesheet exceeds size limit.");
      return res.send(rewriteCss(body, target));
    }

    // Stream binary and other resources without buffering the entire response.
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise(resolve => res.once("drain", resolve));
        }
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (!res.headersSent) {
      return sendError(res, error.name === "AbortError" ? 504 : 502,
        error.name === "AbortError" ? "Upstream request timed out." : "Could not fetch upstream resource.");
    }
    res.end();
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/", (_req, res) => res.redirect("/health"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Eruda proxy listening on port ${PORT}`);
});
