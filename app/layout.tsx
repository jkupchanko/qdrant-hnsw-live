import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HNSW Live · vector search, visualized",
  description:
    "Mission control for a Qdrant Cloud collection at scale — live HNSW traversals, re-ranking, and every search knob in real time.",
  // Versioned URL busts Chrome's stubborn favicon cache
  icons: { icon: "/favicon.ico?v=2" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
