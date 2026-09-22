import { NextRequest, NextResponse } from "next/server";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a phone should actually go.
 *
 * The QR used to encode window.location.origin. On the booth laptop that is
 * http://localhost:3000, which no phone on earth can reach — so the QR
 * looked fine and silently did nothing. This reports an address on the
 * machine's own network instead, which a phone on the same wifi can open.
 *
 * Virtual adapters are skipped on purpose: Hyper-V, WSL and Docker all
 * publish non-internal IPv4 addresses that route nowhere useful from a
 * phone, and this box has a vEthernet interface that would otherwise win.
 */
const SKIP = /^(vEthernet|WSL|Docker|VirtualBox|VMware|Loopback|Bluetooth)/i;

/** Real LAN ranges first; a link-local 169.254 address is a last resort. */
function rank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return 2;
  if (ip.startsWith("169.254.")) return 9;
  return 3;
}

export function GET(req: NextRequest) {
  const candidates: Array<{ ip: string; iface: string }> = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    if (SKIP.test(iface)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) candidates.push({ ip: a.address, iface });
    }
  }
  candidates.sort((a, b) => rank(a.ip) - rank(b.ip));

  const port = req.nextUrl.port || "3000";
  const best = candidates[0];
  return NextResponse.json(
    {
      origin: best ? `http://${best.ip}:${port}` : null,
      iface: best?.iface ?? null,
      candidates: candidates.map((c) => `${c.iface} ${c.ip}`),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
