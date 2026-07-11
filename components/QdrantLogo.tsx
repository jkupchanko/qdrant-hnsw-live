/**
 * Qdrant wordmark. Inline SVG so it works offline, prints crisp at any size,
 * and never fights Vercel's image loader. Colors follow brand: mark red, wordmark light.
 */
export function QdrantLogo({ className = "h-6" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center gap-3 ${className}`}>
      <svg
        viewBox="0 0 32 32"
        aria-hidden
        className="h-full w-auto"
      >
        <defs>
          <linearGradient id="qdrant-mark-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#DC244C" />
            <stop offset="100%" stopColor="#6047FF" />
          </linearGradient>
        </defs>
        <path
          d="M16 2 L28 9 L28 23 L16 30 L4 23 L4 9 Z"
          fill="none"
          stroke="url(#qdrant-mark-grad)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M16 8 L22 11.5 L22 20.5 L16 24 L10 20.5 L10 11.5 Z"
          fill="#DC244C"
        />
      </svg>
      <span
        className="font-sans font-semibold text-fg-primary tracking-tight-brand"
        style={{ fontSize: "1.15em", letterSpacing: "-0.02em" }}
      >
        Qdrant
      </span>
    </div>
  );
}
