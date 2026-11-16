import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { runAgent } from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { message?: string; owner?: string };
    if (!body.message || !body.owner) {
      return NextResponse.json({ error: "message and owner are required" }, { status: 400 });
    }
    const owner = new PublicKey(body.owner);
    const run = await runAgent(body.message.slice(0, 2000), owner);
    return NextResponse.json(run);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
