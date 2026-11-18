// Server-only: the AI agent and the tools it uses to spend from the vault.
//
// The agent holds its own keypair, but it can only move money through the
// AgentVault program, which enforces the owner's policy on-chain. Even if the
// model is tricked into "paying" a bad merchant, the program rejects it.
import { AnchorProvider, type Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  MERCHANTS,
  RPC_URL,
  USDC_MINT,
  ata,
  explorerTx,
  extractError,
  fetchPendingPayments,
  fetchVault,
  fmtUsd,
  fromBaseUnits,
  getProgram,
  merchantName,
  pendingPda,
  spentToday,
  toBaseUnits,
  tokenBalance,
  vaultPda,
  waitForSignature,
} from "./vault";

// --- Agent wallet ------------------------------------------------------------

function loadAgent(): Keypair {
  const raw = process.env.AGENT_SECRET_KEY;
  if (!raw) throw new Error("AGENT_SECRET_KEY is not set. Run `npm run setup` at the repo root.");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function agentProgram(agent: Keypair): { program: Program; connection: Connection } {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = {
    publicKey: agent.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof Transaction) tx.partialSign(agent);
      else tx.sign([agent]);
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      return Promise.all(txs.map((t) => this.signTransaction(t)));
    },
  };
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return { program: getProgram(provider), connection };
}

// --- Tools ---------------------------------------------------------------------

export type ToolResult = Record<string, unknown>;

export const TOOL_DEFS = [
  {
    name: "get_vault_status",
    description:
      "Check the vault's USDC balance, spending limits, today's spend, and which merchants are allowlisted. Call this before paying if you are unsure about limits.",
    parameters: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "list_merchants",
    description: "List known merchants (name, what they sell, and whether the owner has allowlisted them).",
    parameters: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "pay_merchant",
    description:
      "Pay a merchant in USDC from the vault. Payments at or under the approval threshold settle immediately. Larger payments are submitted to the owner for approval on their phone, and are not paid until approved. The on-chain policy may block the payment (merchant not allowlisted, over a limit).",
    parameters: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Merchant name, e.g. 'API Credits Co'" },
        amount_usdc: { type: "number", description: "Amount in USDC (dollars), e.g. 10" },
        memo: { type: "string", description: "Short description of what is being bought (max 64 chars)" },
      },
      required: ["merchant", "amount_usdc", "memo"],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["name"];

export async function executeTool(name: string, args: Record<string, unknown>, owner: PublicKey): Promise<ToolResult> {
  try {
    switch (name) {
      case "get_vault_status":
        return await getVaultStatus(owner);
      case "list_merchants":
        return await listMerchants(owner);
      case "pay_merchant":
        return await payMerchant(owner, String(args.merchant ?? ""), Number(args.amount_usdc), String(args.memo ?? ""));
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function getVaultStatus(owner: PublicKey): Promise<ToolResult> {
  const { program, connection } = agentProgram(loadAgent());
  const vaultKey = vaultPda(owner);
  const v = await fetchVault(program, vaultKey);
  if (!v) return { error: "No vault exists for this owner yet." };
  return {
    balance_usdc: await tokenBalance(connection, ata(vaultKey)),
    per_tx_limit_usdc: fromBaseUnits(v.perTxLimit),
    daily_cap_usdc: fromBaseUnits(v.dailyCap),
    approval_threshold_usdc: fromBaseUnits(v.approvalThreshold),
    spent_today_usdc: spentToday(v),
    paused: v.paused,
    allowlisted_merchants: v.merchants.map((m) => merchantName(m.toBase58())),
  };
}

async function listMerchants(owner: PublicKey): Promise<ToolResult> {
  const { program } = agentProgram(loadAgent());
  const v = await fetchVault(program, vaultPda(owner));
  const allowed = new Set(v?.merchants.map((m) => m.toBase58()) ?? []);
  return {
    merchants: MERCHANTS.map((m) => ({ name: m.name, sells: m.description, allowlisted: allowed.has(m.address) })),
  };
}

function findMerchant(query: string) {
  const q = query.trim().toLowerCase();
  return (
    MERCHANTS.find((m) => m.name.toLowerCase() === q || m.address === query.trim()) ??
    MERCHANTS.find((m) => m.name.toLowerCase().includes(q) || q.includes(m.name.toLowerCase()))
  );
}

async function payMerchant(owner: PublicKey, merchantQuery: string, amountUsdc: number, memo: string): Promise<ToolResult> {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return { status: "error", reason: "Amount must be a positive number" };
  const m = findMerchant(merchantQuery);
  if (!m) return { status: "error", reason: `Unknown merchant "${merchantQuery}". Use list_merchants.` };

  const agent = loadAgent();
  const { program, connection } = agentProgram(agent);
  const vaultKey = vaultPda(owner);
  const v = await fetchVault(program, vaultKey);
  if (!v) return { status: "error", reason: "No vault exists for this owner yet." };

  const merchant = new PublicKey(m.address);
  const amount = toBaseUnits(amountUsdc);
  const trimmedMemo = memo.slice(0, 64);
  const needsApproval = amount.gt(v.approvalThreshold);

  // Build the instruction. The agent picks the path, but the program enforces
  // it: `pay` rejects anything above the threshold.
  const tx = needsApproval
    ? await program.methods
        .requestApproval(amount, trimmedMemo)
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultKey,
          merchant,
          pending: pendingPda(vaultKey, v.nextPaymentId),
        })
        .transaction()
    : await program.methods
        .pay(amount, trimmedMemo)
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultKey,
          mint: USDC_MINT,
          vaultToken: ata(vaultKey),
          merchant,
          merchantToken: ata(merchant),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();

  // skipPreflight so that a payment the firewall rejects still lands on-chain
  // as a failed transaction. That gives the owner a tamper-proof audit trail
  // of everything the agent attempted, including blocked attempts.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(agent);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = { value: await waitForSignature(connection, signature) };

  const base = { merchant: m.name, amount_usdc: amountUsdc, memo: trimmedMemo, signature, explorer: explorerTx(signature) };
  if (conf.value.err) {
    const failed = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    return { ...base, status: "blocked", reason: `Blocked by vault policy: ${extractError(failed?.meta?.logMessages)}` };
  }
  if (needsApproval) {
    return {
      ...base,
      status: "held_for_approval",
      reason: `Above the ${fmtUsd(fromBaseUnits(v.approvalThreshold))} approval threshold. Waiting for the owner to approve in their wallet. Not paid yet.`,
    };
  }
  return { ...base, status: "sent" };
}

export async function pendingSummary(owner: PublicKey) {
  const { program } = agentProgram(loadAgent());
  return fetchPendingPayments(program, vaultPda(owner));
}
