// Shared helpers for talking to the AgentVault program (browser + server).
import { AnchorProvider, BN, BorshCoder, EventParser, Program, type Idl } from "@anchor-lang/core";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import idlJson from "@/idl/agentvault.json";
import merchantsJson from "@/merchants.json";

export const IDL = idlJson as Idl;
export const PROGRAM_ID = new PublicKey(IDL.address);
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
export const USDC_DECIMALS = 6;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

export type Merchant = { name: string; description: string; address: string };
export const MERCHANTS: Merchant[] = merchantsJson as Merchant[];

export function merchantName(address: string): string {
  return MERCHANTS.find((m) => m.address === address)?.name ?? short(address);
}

export function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function explorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

// --- PDAs ------------------------------------------------------------------

export function vaultPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), owner.toBytes()], PROGRAM_ID)[0];
}

export function pendingPda(vault: PublicKey, id: BN | number): PublicKey {
  const idBn = BN.isBN(id) ? id : new BN(id);
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("pending"), vault.toBytes(), Uint8Array.from(idBn.toArray("le", 8))],
    PROGRAM_ID,
  )[0];
}

export function ata(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_MINT, owner, true);
}

// --- Units -----------------------------------------------------------------

export function toBaseUnits(usdc: number): BN {
  return new BN(Math.round(usdc * 10 ** USDC_DECIMALS));
}

export function fromBaseUnits(amount: BN | number | bigint | null | undefined): number {
  if (amount === null || amount === undefined) return 0;
  return Number(amount.toString()) / 10 ** USDC_DECIMALS;
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// --- Program ----------------------------------------------------------------

export function getProgram(provider: AnchorProvider): Program {
  return new Program(IDL, provider);
}

/** Decoded on-chain Vault account (anchor converts fields to camelCase). */
export type VaultAccount = {
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  perTxLimit: BN;
  dailyCap: BN;
  approvalThreshold: BN;
  spentToday: BN;
  day: BN;
  merchants: PublicKey[];
  nextPaymentId: BN;
  paused: boolean;
  bump: number;
};

export type PendingAccount = {
  vault: PublicKey;
  id: BN;
  merchant: PublicKey;
  amount: BN;
  memo: string;
  createdAt: BN;
  status: { pending?: object; approved?: object; rejected?: object };
  bump: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccounts = any;

export async function fetchVault(program: Program, vault: PublicKey): Promise<VaultAccount | null> {
  return ((program.account as AnyAccounts).vault.fetchNullable(vault)) as Promise<VaultAccount | null>;
}

export async function fetchPendingPayments(
  program: Program,
  vault: PublicKey,
): Promise<{ publicKey: PublicKey; account: PendingAccount }[]> {
  // Held payments live at PDAs ["pending", vault, id] for id = 0..nextPaymentId-1,
  // so we can compute their addresses and fetch them directly. This avoids
  // getProgramAccounts, which free RPC plans (e.g. Alchemy) don't allow.
  const v = await fetchVault(program, vault);
  if (!v) return [];
  const count = v.nextPaymentId.toNumber();
  const ids = Array.from({ length: Math.min(count, 50) }, (_, i) => count - 1 - i); // newest 50
  if (ids.length === 0) return [];
  const keys = ids.map((id) => pendingPda(vault, id));
  const accounts = (await (program.account as AnyAccounts).pendingPayment.fetchMultiple(keys)) as (PendingAccount | null)[];
  return keys
    .map((publicKey, i) => ({ publicKey, account: accounts[i] }))
    .filter((x): x is { publicKey: PublicKey; account: PendingAccount } => x.account !== null);
}

/** Today's spend, taking the on-chain daily rollover into account. */
export function spentToday(v: VaultAccount): number {
  const today = Math.floor(Date.now() / 1000 / 86400);
  return v.day.toNumber() === today ? fromBaseUnits(v.spentToday) : 0;
}

export async function tokenBalance(connection: Connection, account: PublicKey): Promise<number> {
  try {
    const bal = await connection.getTokenAccountBalance(account);
    return Number(bal.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

// --- Audit log ---------------------------------------------------------------

export type AuditEntry = {
  signature: string;
  time: number | null;
  ok: boolean;
  kind: string;
  detail: string;
};

const eventParser = () => new EventParser(PROGRAM_ID, new BorshCoder(IDL));

/** Pulls a human-readable reason out of a failed transaction's logs. */
export function extractError(logs: string[] | null | undefined): string {
  for (const line of logs ?? []) {
    const m = line.match(/Error Message: (.*?)\.?$/);
    if (m) return m[1];
  }
  return "Transaction failed";
}

function describeEvent(name: string, data: Record<string, unknown>): { kind: string; detail: string } {
  const amt = (k = "amount") => fmtUsd(fromBaseUnits(data[k] as BN));
  const merchant = () => (data.merchant ? merchantName((data.merchant as PublicKey).toBase58()) : "unknown merchant");
  switch (name) {
    case "paymentSent":
    case "PaymentSent":
      return { kind: "Paid", detail: `${amt()} to ${merchant()}${data.memo ? `: ${data.memo}` : ""}` };
    case "paymentHeld":
    case "PaymentHeld":
      return { kind: "Held", detail: `${amt()} to ${merchant()} awaiting approval${data.memo ? `: ${data.memo}` : ""}` };
    case "paymentApproved":
    case "PaymentApproved":
      return { kind: "Approved", detail: `${amt()} to ${merchant()} approved by owner` };
    case "paymentRejected":
    case "PaymentRejected":
      return { kind: "Rejected", detail: `Payment #${String(data.paymentId)} rejected by owner` };
    case "policyUpdated":
    case "PolicyUpdated":
      return {
        kind: "Policy",
        detail: `Limits: per-tx ${amt("perTxLimit")}, daily ${amt("dailyCap")}, approval over ${amt("approvalThreshold")}${data.paused ? " (paused)" : ""}`,
      };
    case "merchantsUpdated":
    case "MerchantsUpdated":
      return {
        kind: "Allowlist",
        detail: `Allowlist: ${((data.merchants as PublicKey[]) ?? []).map((m) => merchantName(m.toBase58())).join(", ") || "empty"}`,
      };
    default:
      return { kind: name, detail: "" };
  }
}

const txCache = new Map<string, Awaited<ReturnType<Connection["getTransaction"]>>>();

export async function fetchAuditLog(connection: Connection, vault: PublicKey, limit = 25): Promise<AuditEntry[]> {
  const sigs = await connection.getSignaturesForAddress(vault, { limit: Math.min(limit, 10) }, "confirmed");
  if (sigs.length === 0) return [];
  // Fetch one by one (public RPCs often reject or rate-limit batch requests).
  // Sequential, cached: transactions never change once confirmed.
  const txs: (Awaited<ReturnType<Connection["getTransaction"]>> | null)[] = [];
  for (const s of sigs) {
    if (!txCache.has(s.signature)) {
      const tx = await connection
        .getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
        .catch(() => null);
      if (tx) txCache.set(s.signature, tx);
    }
    txs.push(txCache.get(s.signature) ?? null);
  }
  const parser = eventParser();
  return sigs.map((s, i) => {
    const base = { signature: s.signature, time: s.blockTime ?? null };
    const logs = txs[i]?.meta?.logMessages ?? [];
    if (s.err) return { ...base, ok: false, kind: "Blocked", detail: extractError(logs) };
    try {
      const events = Array.from(parser.parseLogs(logs));
      if (events.length === 0) return { ...base, ok: true, kind: "Tx", detail: "Vault transaction" };
      // Event field names may arrive as snake_case or camelCase; normalise to camelCase.
      const raw = events[0].data as Record<string, unknown>;
      const data = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
      );
      return { ...base, ok: true, ...describeEvent(events[0].name, data) };
    } catch (e) {
      console.warn("could not decode event", s.signature, e);
      return { ...base, ok: true, kind: "Tx", detail: "Vault transaction" };
    }
  });
}

/**
 * Waits for a transaction by polling over HTTP. Public devnet websockets often
 * drop confirmation messages, so we don't rely on `confirmTransaction`.
 * Returns the transaction error (null on success).
 */
export async function waitForSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 60_000,
): Promise<{ err: unknown }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = value[0];
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      return { err: s.err };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for transaction ${signature}. It may still land; refresh in a moment.`);
}
