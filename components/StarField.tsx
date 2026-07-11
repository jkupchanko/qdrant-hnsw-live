"use client";

import { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  a: number;
  ta: number;
  hue: number;
}

/**
 * Ambient starfield: hundreds of drifting, twinkling points on a dark background.
 * Sits behind every scene so the whole demo shares one visual world.
 */
export function StarField({ density = 220 }: { density?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let stars: Star[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const seed = () => {
      stars = Array.from({ length: density }, () => {
        const r = Math.random();
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          r: r < 0.9 ? 0.6 + Math.random() * 0.8 : 1.4 + Math.random() * 1.3,
          vx: (Math.random() - 0.5) * 0.02,
          vy: (Math.random() - 0.5) * 0.02,
          a: Math.random() * 0.6 + 0.15,
          ta: Math.random() * 0.6 + 0.35,
          // Mostly white; a small proportion tinted red or violet for on-brand accent
          hue: Math.random() < 0.08 ? (Math.random() < 0.5 ? 348 : 249) : 220,
        };
      });
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < 0) s.x += width;
        if (s.x > width) s.x -= width;
        if (s.y < 0) s.y += height;
        if (s.y > height) s.y -= height;

        // Slow twinkle
        s.a += (s.ta - s.a) * 0.02;
        if (Math.abs(s.a - s.ta) < 0.02) s.ta = Math.random() * 0.6 + 0.25;

        const fill = s.hue === 220
          ? `rgba(240, 243, 250, ${s.a})`
          : s.hue === 348
            ? `rgba(255, 135, 146, ${s.a})`
            : `rgba(194, 197, 255, ${s.a})`;

        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [density]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 h-full w-full pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}
