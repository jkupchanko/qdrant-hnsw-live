/**
 * Posters go through our own cached proxy rather than straight to Wikipedia —
 * see app/api/poster/route.ts for why. Anything that isn't a Wikipedia upload
 * is passed through untouched so the proxy stays a narrow allow-list.
 */
export function posterSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith("https://upload.wikimedia.org/")) return url;
  return `/api/poster?u=${encodeURIComponent(url)}`;
}
