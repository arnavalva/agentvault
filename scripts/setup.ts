/**
 * One-time devnet setup for the AgentVault demo.
 *
 *   npm run setup
 *
 * What it does (using your Solana CLI wallet at ~/.config/solana/id.json):
 *   1. Creates the AI agent's keypair (keys/agent.json) and funds it with a little SOL for fees.
 *   2. Creates three demo merchant wallets and their USDC token accounts.
 *   3. Writes app/src/merchants.json and app/.env.local for the dashboard.
 *
 * Safe to re-run: existing keys are reused, and existing .env.local values (like your
 * GEMINI_API_KEY) are kept.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const DEMO_MERCHANTS = [
  { slug: "api-credits", name: "API Credits Co", description: "Pay-as-you-go LLM and API credits" },
  { slug: "datamart", name: "DataMart", description: "Marketplace for licensed training datasets" },
  { slug: "shadygpu", name: "ShadyGPU Rentals", description: "Unverified GPU reseller (left OFF the allowlist for the demo)" },
];

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const walletPath = process.env.ANCHOR_WALLET ?? join(homedir(), ".config/solana/id.json");
  const payer = loadKeypair(walletPath);
  console.log(`Payer (your CLI wallet): ${payer.publicKey.toBase58()}`);
  const payerBalance = await connection.getBalance(payer.publicKey);
  console.log(`  balance: ${(payerBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  if (payerBalance < 0.5 * LAMPORTS_PER_SOL) {
    throw new Error("Payer needs at least 0.5 devnet SOL. Run `solana airdrop 2` or use faucet.solana.com.");
  }

  mkdirSync("keys", { recursive: true });

  // 1. Agent keypair, funded for transaction fees + pending-payment rent.
  const agent = loadOrCreateKeypair("keys/agent.json");
  const agentBalance = await connection.getBalance(agent.publicKey);
  console.log(`Agent: ${agent.publicKey.toBase58()} (${(agentBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);
  if (agentBalance < 0.1 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: agent.publicKey,
        lamports: 0.3 * LAMPORTS_PER_SOL,
      }),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("  funded agent with 0.3 SOL");
  }

  // 2. Merchant wallets + their USDC token accounts (so payments can land).
  const merchants = [];
  for (const m of DEMO_MERCHANTS) {
    const kp = loadOrCreateKeypair(`keys/merchant-${m.slug}.json`);
    await getOrCreateAssociatedTokenAccount(connection, payer, USDC_MINT, kp.publicKey);
    merchants.push({ name: m.name, description: m.description, address: kp.publicKey.toBase58() });
    console.log(`Merchant ${m.name}: ${kp.publicKey.toBase58()}`);
  }
  mkdirSync("app/src", { recursive: true });
  writeFileSync("app/src/merchants.json", JSON.stringify(merchants, null, 2) + "\n");
  console.log("Wrote app/src/merchants.json");

  // 3. Dashboard env file (merging with anything already there).
  const envPath = "app/.env.local";
  const env = {
    LLM_PROVIDER: "gemini",
    GEMINI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ...readEnv(envPath),
    AGENT_SECRET_KEY: JSON.stringify(Array.from(agent.secretKey)),
    NEXT_PUBLIC_AGENT_PUBKEY: agent.publicKey.toBase58(),
    NEXT_PUBLIC_USDC_MINT: USDC_MINT.toBase58(),
    NEXT_PUBLIC_RPC_URL: RPC_URL,
  };
  writeFileSync(
    envPath,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );
  console.log(`Wrote ${envPath}. Add your GEMINI_API_KEY there if it is empty.`);
  console.log("\nDone. Next: cd app && npm install && npm run dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
