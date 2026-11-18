"use client";
import { AnchorProvider, type Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MERCHANTS,
  USDC_DECIMALS,
  USDC_MINT,
  ata,
  explorerAddress,
  explorerTx,
  fetchAuditLog,
  fetchPendingPayments,
  fetchVault,
  fmtUsd,
  fromBaseUnits,
  getProgram,
  merchantName,
  spentToday,
  toBaseUnits,
  tokenBalance,
  vaultPda,
  waitForSignature,
  type AuditEntry,
  type PendingAccount,
  type VaultAccount,
} from "@/lib/vault";

const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

const AGENT_PUBKEY = process.env.NEXT_PUBLIC_AGENT_PUBKEY ?? "";

type Pending = { publicKey: PublicKey; account: PendingAccount };

export function Dashboard() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const owner = anchorWallet?.publicKey ?? null;

  const program = useMemo<Program | null>(() => {
    if (!anchorWallet) return null;
    return getProgram(new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" }));
  }, [connection, anchorWallet]);

  const vaultKey = useMemo(() => (owner ? vaultPda(owner) : null), [owner]);
  const [vault, setVault] = useState<VaultAccount | null | undefined>(undefined);
  const [balance, setBalance] = useState(0);
  const [walletUsdc, setWalletUsdc] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!program || !vaultKey || !owner) return;
    try {
      const v = await fetchVault(program, vaultKey);
      setVault(v);
      setWalletUsdc(await tokenBalance(connection, ata(owner)));
      if (!v) return;
      const [bal, p] = await Promise.all([
        tokenBalance(connection, ata(vaultKey)),
        fetchPendingPayments(program, vaultKey),
      ]);
      setBalance(bal);
      setPending(p);
      // The audit log is best-effort: never let it block balances or approvals.
      fetchAuditLog(connection, vaultKey)
        .then((log) => { setAudit(log); setAuditError(null); })
        .catch((e) => { console.warn("audit log", e); setAuditError(e instanceof Error ? e.message : String(e)); });
    } catch (e) {
      console.warn("refresh failed", e);
    }
  }, [program, vaultKey, owner, connection]);

  useEffect(() => {
    setVault(undefined);
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Sends an owner-signed transaction built by `build`, then refreshes.
  const { sendTransaction } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (label: string, build: () => Promise<Transaction>) => {
      setBusy(label);
      setError(null);
      try {
        const tx = await build();
        const sig = await sendTransaction(tx, connection);
        const { err } = await waitForSignature(connection, sig);
        if (err) throw new Error(`Transaction failed: ${JSON.stringify(err)}`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [connection, sendTransaction, refresh],
  );

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <h1>🛡️ AgentVault</h1>
          <span>On-chain spending firewall for AI agents · Solana devnet</span>
        </div>
        <WalletMultiButton />
      </header>

      {error && <div className="card error" style={{ marginBottom: 16 }}>{error}</div>}

      {!owner && (
        <div className="card hero">
          <h2>Give your AI agent a wallet, not a blank cheque.</h2>
          <p className="muted">
            Connect Phantom (devnet) as the vault owner. Your agent can spend USDC only within the rules you set
            on-chain, and anything big waits for your approval.
          </p>
        </div>
      )}

      {owner && vault === undefined && <div className="card">Loading vault…</div>}

      {owner && program && vaultKey && vault === null && (
        <CreateVault
          busy={busy}
          onCreate={(agent, perTx, daily, threshold) =>
            run("create", () =>
              program.methods
                .initialize(new PublicKey(agent), toBaseUnits(perTx), toBaseUnits(daily), toBaseUnits(threshold))
                .accountsPartial({
                  owner,
                  vault: vaultKey,
                  mint: USDC_MINT,
                  vaultToken: ata(vaultKey),
                  tokenProgram: TOKEN_PROGRAM_ID,
                  systemProgram: SystemProgram.programId,
                })
                .transaction(),
            )
          }
        />
      )}

      {owner && program && vaultKey && vault && (
        <div className="grid">
          <div className="card span-4">
            <h2>Vault balance</h2>
            <div className="big">{fmtUsd(balance)}</div>
            <div className="muted">USDC held by the vault program, not the agent</div>
            <SpendBar vault={vault} />
            <Deposit
              walletUsdc={walletUsdc}
              busy={busy}
              onDeposit={(amount) =>
                run("deposit", async () =>
                  new Transaction().add(
                    createTransferCheckedInstruction(
                      ata(owner),
                      USDC_MINT,
                      ata(vaultKey),
                      owner,
                      BigInt(toBaseUnits(amount).toString()),
                      USDC_DECIMALS,
                    ),
                  ),
                )
              }
            />
            <p className="muted" style={{ marginTop: 12 }}>
              Vault: <a href={explorerAddress(vaultKey.toBase58())} target="_blank" rel="noreferrer" className="mono">{vaultKey.toBase58()}</a>
              <br />
              Agent: <span className="mono">{vault.agent.toBase58()}</span>
            </p>
          </div>

          <div className="card span-8">
            <h2>Approval queue</h2>
            <ApprovalQueue
              pending={pending}
              busy={busy}
              onApprove={(p) =>
                run(`approve-${p.account.id}`, () =>
                  program.methods
                    .approve()
                    .accountsPartial({
                      owner,
                      vault: vaultKey,
                      pending: p.publicKey,
                      mint: USDC_MINT,
                      vaultToken: ata(vaultKey),
                      merchant: p.account.merchant,
                      merchantToken: ata(p.account.merchant),
                      tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .preInstructions([
                      // Make sure the merchant can receive USDC (no-op if it already can).
                      createAssociatedTokenAccountIdempotentInstruction(owner, ata(p.account.merchant), p.account.merchant, USDC_MINT),
                    ])
                    .transaction(),
                )
              }
              onReject={(p) =>
                run(`reject-${p.account.id}`, () =>
                  program.methods
                    .reject()
                    .accountsPartial({ owner, vault: vaultKey, pending: p.publicKey })
                    .transaction(),
                )
              }
            />
          </div>

          <div className="card span-5">
            <h2>Rules (enforced on-chain)</h2>
            <Policy
              vault={vault}
              busy={busy}
              onSave={(perTx, daily, threshold, paused) =>
                run("policy", () =>
                  program.methods
                    .updatePolicy(vault.agent, toBaseUnits(perTx), toBaseUnits(daily), toBaseUnits(threshold), paused)
                    .accountsPartial({ owner, vault: vaultKey })
                    .transaction(),
                )
              }
              onSetMerchants={(list) =>
                run("merchants", () =>
                  program.methods
                    .setMerchants(list.map((a) => new PublicKey(a)))
                    .accountsPartial({ owner, vault: vaultKey })
                    .transaction(),
                )
              }
            />
          </div>

          <div className="card span-7">
            <h2>Talk to the agent</h2>
            <AgentChat owner={owner.toBase58()} onDone={refresh} />
          </div>

          <div className="card span-12">
            <h2>Audit log (from on-chain history)</h2>
            <AuditLog entries={audit} />
            {auditError && <div className="error">Audit log error: {auditError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CreateVault({
  busy,
  onCreate,
}: {
  busy: string | null;
  onCreate: (agent: string, perTx: number, daily: number, threshold: number) => void;
}) {
  const [agent, setAgent] = useState(AGENT_PUBKEY);
  const [perTx, setPerTx] = useState(10);
  const [daily, setDaily] = useState(15);
  const [threshold, setThreshold] = useState(5);
  return (
    <div className="card" style={{ maxWidth: 560, margin: "0 auto" }}>
      <h2>Create your vault</h2>
      <p className="muted">You are the owner. The agent below can spend only within these limits.</p>
      <div className="list">
        <label className="field">Agent public key<input type="text" value={agent} onChange={(e) => setAgent(e.target.value)} /></label>
        <div className="row">
          <label className="field">Per-payment limit ($)<input type="number" value={perTx} onChange={(e) => setPerTx(+e.target.value)} /></label>
          <label className="field">Daily cap ($)<input type="number" value={daily} onChange={(e) => setDaily(+e.target.value)} /></label>
          <label className="field">Needs approval above ($)<input type="number" value={threshold} onChange={(e) => setThreshold(+e.target.value)} /></label>
        </div>
        <button disabled={!!busy || !agent} onClick={() => onCreate(agent, perTx, daily, threshold)}>
          {busy === "create" ? "Creating…" : "Create vault"}
        </button>
      </div>
    </div>
  );
}

function SpendBar({ vault }: { vault: VaultAccount }) {
  const spent = spentToday(vault);
  const cap = fromBaseUnits(vault.dailyCap);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="row between muted">
        <span>Spent today</span>
        <span>{fmtUsd(spent)} / {fmtUsd(cap)}</span>
      </div>
      <div className="bar"><div style={{ width: `${Math.min(100, (spent / Math.max(cap, 0.000001)) * 100)}%` }} /></div>
    </div>
  );
}

function Deposit({ walletUsdc, busy, onDeposit }: { walletUsdc: number; busy: string | null; onDeposit: (n: number) => void }) {
  const [amount, setAmount] = useState(15);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row">
        <input type="number" value={amount} onChange={(e) => setAmount(+e.target.value)} style={{ flex: 1, width: "auto" }} />
        <button disabled={!!busy || amount <= 0 || amount > walletUsdc} onClick={() => onDeposit(amount)}>
          {busy === "deposit" ? "Depositing…" : "Deposit"}
        </button>
      </div>
      <div className="muted" style={{ marginTop: 4 }}>Your wallet: {fmtUsd(walletUsdc)} USDC (get more at faucet.circle.com)</div>
    </div>
  );
}

function ApprovalQueue({
  pending,
  busy,
  onApprove,
  onReject,
}: {
  pending: Pending[];
  busy: string | null;
  onApprove: (p: Pending) => void;
  onReject: (p: Pending) => void;
}) {
  const open = pending.filter((p) => p.account.status.pending);
  const done = pending.filter((p) => !p.account.status.pending).slice(0, 4);
  if (pending.length === 0) return <p className="muted">Nothing waiting. Payments above your approval threshold will show up here.</p>;
  return (
    <div className="list">
      {open.map((p) => (
        <div key={p.publicKey.toBase58()} className="item pending">
          <div className="row between">
            <div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{fmtUsd(fromBaseUnits(p.account.amount))} → {merchantName(p.account.merchant.toBase58())}</div>
              <div className="muted">{p.account.memo || "No memo"} · requested {new Date(p.account.createdAt.toNumber() * 1000).toLocaleTimeString()}</div>
            </div>
            <div className="row">
              <button className="red" disabled={!!busy} onClick={() => onReject(p)}>Reject</button>
              <button className="green" disabled={!!busy} onClick={() => onApprove(p)}>
                {busy === `approve-${p.account.id}` ? "Approving…" : "Approve"}
              </button>
            </div>
          </div>
        </div>
      ))}
      {done.map((p) => (
        <div key={p.publicKey.toBase58()} className="item row between">
          <span>{fmtUsd(fromBaseUnits(p.account.amount))} → {merchantName(p.account.merchant.toBase58())}</span>
          <span className={`pill ${p.account.status.approved ? "Approved" : "Rejected"}`}>{p.account.status.approved ? "Approved" : "Rejected"}</span>
        </div>
      ))}
    </div>
  );
}

function Policy({
  vault,
  busy,
  onSave,
  onSetMerchants,
}: {
  vault: VaultAccount;
  busy: string | null;
  onSave: (perTx: number, daily: number, threshold: number, paused: boolean) => void;
  onSetMerchants: (addresses: string[]) => void;
}) {
  const [perTx, setPerTx] = useState(fromBaseUnits(vault.perTxLimit));
  const [daily, setDaily] = useState(fromBaseUnits(vault.dailyCap));
  const [threshold, setThreshold] = useState(fromBaseUnits(vault.approvalThreshold));
  const allowed = new Set(vault.merchants.map((m) => m.toBase58()));
  const toggle = (addr: string) => {
    const next = new Set(allowed);
    if (next.has(addr)) next.delete(addr);
    else next.add(addr);
    onSetMerchants(Array.from(next));
  };
  return (
    <div className="list">
      <div className="row">
        <label className="field">Per-payment ($)<input type="number" value={perTx} onChange={(e) => setPerTx(+e.target.value)} /></label>
        <label className="field">Daily cap ($)<input type="number" value={daily} onChange={(e) => setDaily(+e.target.value)} /></label>
        <label className="field">Approve above ($)<input type="number" value={threshold} onChange={(e) => setThreshold(+e.target.value)} /></label>
      </div>
      <div className="row">
        <button disabled={!!busy} onClick={() => onSave(perTx, daily, threshold, vault.paused)}>{busy === "policy" ? "Saving…" : "Save limits"}</button>
        <button className={vault.paused ? "green" : "ghost"} disabled={!!busy} onClick={() => onSave(perTx, daily, threshold, !vault.paused)}>
          {vault.paused ? "Resume agent" : "Pause agent"}
        </button>
      </div>
      <div>
        <div className="muted" style={{ margin: "6px 0" }}>Merchant allowlist</div>
        {MERCHANTS.length === 0 && <p className="muted">No demo merchants yet. Run <code>npm run setup</code>.</p>}
        {MERCHANTS.map((m) => (
          <label key={m.address} className="merchant">
            <input type="checkbox" checked={allowed.has(m.address)} disabled={!!busy} onChange={() => toggle(m.address)} />
            <span>
              <strong>{m.name}</strong>
              <br />
              <span className="muted">{m.description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

type AgentResponse = {
  provider: string;
  reply: string;
  steps: { tool: string; args: Record<string, unknown>; result: Record<string, unknown> }[];
  error?: string;
};

function AgentChat({ owner, onDone }: { owner: string; onDone: () => void }) {
  const [message, setMessage] = useState("Buy $3 of API credits from API Credits Co and book the $8 customer reviews dataset from DataMart.");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<AgentResponse | null>(null);
  const send = async () => {
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, owner }),
      });
      setRes((await r.json()) as AgentResponse);
    } catch (e) {
      setRes({ provider: "", reply: "", steps: [], error: String(e) });
    } finally {
      setLoading(false);
      onDone();
    }
  };
  return (
    <div>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={loading || !message.trim()} onClick={send}>{loading ? "Agent working…" : "Send to agent"}</button>
        <button className="ghost" disabled={loading} onClick={() => setMessage("Rent 4 dollars of GPU time from ShadyGPU Rentals.")}>Try a sketchy merchant</button>
      </div>
      {res?.error && <div className="error">{res.error}</div>}
      {res && !res.error && (
        <>
          <div className="list" style={{ marginTop: 12 }}>
            {res.steps.filter((s) => s.tool === "pay_merchant").map((s, i) => (
              <div key={i} className="item">
                <div className="row between">
                  <strong>{fmtUsd(Number(s.args.amount_usdc))} → {String(s.args.merchant)}</strong>
                  <span className={`pill ${String(s.result.status ?? "error")}`}>{labelFor(String(s.result.status ?? "error"))}</span>
                </div>
                {typeof s.result.reason === "string" && <div className="muted">{s.result.reason}</div>}
                {typeof s.result.signature === "string" && (
                  <a className="muted" href={explorerTx(s.result.signature)} target="_blank" rel="noreferrer">View transaction ↗</a>
                )}
              </div>
            ))}
          </div>
          {res.reply && <div className="chat-reply">{res.reply}</div>}
          <div className="muted" style={{ marginTop: 6 }}>Model: {res.provider}</div>
        </>
      )}
    </div>
  );
}

function labelFor(status: string) {
  return { sent: "Paid", held_for_approval: "Held for approval", blocked: "Blocked", error: "Error" }[status] ?? status;
}

function AuditLog({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr><th>Time</th><th>Event</th><th>Details</th><th>Tx</th></tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.signature}>
              <td className="muted">{e.time ? new Date(e.time * 1000).toLocaleTimeString() : "…"}</td>
              <td><span className={`pill ${e.kind}`}>{e.kind}</span></td>
              <td>{e.detail}</td>
              <td><a href={explorerTx(e.signature)} target="_blank" rel="noreferrer" className="mono">{e.signature.slice(0, 8)}…</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
