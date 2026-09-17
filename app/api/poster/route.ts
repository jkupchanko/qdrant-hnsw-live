import { NextRequest } from "next/server";

/**
 * Poster proxy.
 *
 * Cards used to hotlink straight to upload.wikimedia.org. That is fine on a
 * desk and a liability at an event: conference wifi, a captive portal or a
 * blocked domain and every card on the screen goes blank for the rest of the
 * day. Going through here means Vercel's CDN holds the bytes after the first
 * fetch, so the loop only ever needs Wikipedia once per poster.
 *
 * Allow-listed on purpose — an open image proxy is an SSRF hole.
 */
const ALLOWED_HOSTS = new Set(["upload.wikimedia.org"]);

export const revalidate = false;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) return new Response("missing u", { status: 400 });

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    return new Response("host not allowed", { status: 403 });
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { "user-agent": "qdrant-hnsw-live/1.0 (booth demo; contact: qdrant.tech)" },
      cache: "force-cache",
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok || !upstream.body) {
      return new Response("upstream failed", { status: 502 });
    }
    const type = upstream.headers.get("content-type") ?? "image/jpeg";
    if (!type.startsWith("image/")) return new Response("not an image", { status: 415 });

    return new Response(upstream.body, {
      headers: {
        "content-type": type,
        // Posters are content-addressed by Wikipedia; they never change.
        "cache-control": "public, max-age=31536000, s-maxage=31536000, immutable",
      },
    });
  } catch {
    return new Response("upstream error", { status: 504 });
  }
}
