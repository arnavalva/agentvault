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

export function fromBaseUnits(amount: BN | number | bigint): number {
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
  const all = await (program.account as AnyAccounts).pendingPayment.all([
    { memcmp: { offset: 8, bytes: vault.toBase58() } },
  ]);
  return (all as { publicKey: PublicKey; account: PendingAccount }[]).sort((a, b) =>
    b.account.id.cmp(a.account.id),
  );
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
  const merchant = () => merchantName((data.merchant as PublicKey).toBase58());
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

export async function fetchAuditLog(connection: Connection, vault: PublicKey, limit = 25): Promise<AuditEntry[]> {
  const sigs = await connection.getSignaturesForAddress(vault, { limit }, "confirmed");
  if (sigs.length === 0) return [];
  const txs = await connection.getTransactions(
    sigs.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  );
  const parser = eventParser();
  return sigs.map((s, i) => {
    const tx = txs[i];
    const logs = tx?.meta?.logMessages ?? [];
    if (s.err) {
      return { signature: s.signature, time: s.blockTime ?? null, ok: false, kind: "Blocked", detail: extractError(logs) };
    }
    const events = Array.from(parser.parseLogs(logs));
    if (events.length === 0) {
      return { signature: s.signature, time: s.blockTime ?? null, ok: true, kind: "Tx", detail: "Vault transaction" };
    }
    const d = describeEvent(events[0].name, events[0].data as Record<string, unknown>);
    return { signature: s.signature, time: s.blockTime ?? null, ok: true, ...d };
  });
}
