"use client";

import { useState } from "react";
import { QdrantLogo } from "@/components/QdrantLogo";

/**
 * The phone side of the QR hand-off. Type a query here and it appears on
 * the booth's big screen within a couple of seconds.
 */
export default function RemotePage() {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || state === "sending") return;
    setState("sending");
    try {
      const r = await fetch("/api/remote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      if (!r.ok) throw new Error();
      setState("sent");
      setText("");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-10 text-center">
      <QdrantLogo className="h-8 mb-8" />
      <h1 className="text-2xl font-semibold tracking-tight-brand text-fg-primary max-w-[22ch]">
        Search the big screen from here.
      </h1>
      <p className="mt-2 mb-8 text-sm text-fg-secondary max-w-[36ch]">
        Describe a movie any way you like. Your words become a vector and search
        19,907 films on the booth display.
      </p>
      <form onSubmit={send} className="w-full max-w-[420px]">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="a heist that goes sideways…"
          className="w-full rounded-lg bg-white/[0.05] ring-1 ring-white/[0.1] px-4 py-3.5 text-base text-fg-primary placeholder:text-fg-secondary/60 outline-none focus:ring-qdrant-red/60"
        />
        <button
          type="submit"
          disabled={state === "sending" || !text.trim()}
          className="mt-3 w-full rounded-lg bg-qdrant-red py-3.5 text-base font-semibold text-white transition-opacity disabled:opacity-40"
        >
          {state === "sending" ? "Sending…" : state === "sent" ? "On the big screen ✓" : state === "error" ? "Try again" : "Send to the big screen"}
        </button>
      </form>
      <p className="mt-10 text-[11px] text-fg-secondary/60">
        Powered by Qdrant Cloud · qdrant.tech
      </p>
    </div>
  );
}
