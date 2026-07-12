/**
 * Official Qdrant lockup (brandmark + wordmark), served from /public.
 * Source: qdrant.tech/img/qdrant-logo.svg — white wordmark, for dark surfaces.
 */
export function QdrantLogo({ className = "h-6" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/qdrant-logo.svg"
      alt="Qdrant"
      className={`${className} w-auto select-none`}
      draggable={false}
    />
  );
}
