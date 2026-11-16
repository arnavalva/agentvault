# 🛡️ AgentVault

**An on-chain spending firewall for AI agents.** Give your agent a USDC wallet, not a blank cheque.

AI agents are starting to pay for things on their own: API credits, datasets, compute. Today that usually means handing an agent a private key or a card and hoping the prompt holds. One prompt injection or one hallucinated invoice, and the wallet is empty.

AgentVault puts a Solana program between the agent and the money. The agent can *ask* to pay. The program decides, using rules only the human owner can change:

| Rule | What happens |
|---|---|
| Merchant allowlist | Payments to anyone not on the list are **blocked** on-chain |
| Per-payment limit | Anything over the limit is **blocked** |
| Daily cap | Spending resets every 24h; going over is **blocked** |
| Approval threshold | Payments above it are **held** until the owner taps Approve in Phantom |
| Pause switch | Owner can freeze all agent spending instantly |

Because the checks run on-chain, they hold even if the agent's model is jailbroken, the server running it is compromised, or the agent's key leaks. The agent key can never move funds outside the policy.

## Demo

> "Buy $3 of API credits and book the $8 customer reviews dataset."

1. **$3 to API Credits Co** is under the $5 threshold, so it's paid instantly.
2. **$8 to DataMart** is over the threshold, so it's **held**. The owner's phone (Phantom) shows it in the approval queue.
3. Owner taps **Approve**, and the payment settles.
4. "Rent GPU time from ShadyGPU Rentals" is **blocked** because that merchant isn't allowlisted. The failed attempt is still recorded on-chain in the audit log.

## Architecture

```
            ┌──────────────────────┐   tool calls    ┌──────────────────────────┐
  "buy X" → │  AI agent (LLM)      │ ──────────────► │ Agent API (Next.js route)│
            │  Gemini / Claude     │ ◄────────────── │ signs with AGENT key     │
            └──────────────────────┘    results      └────────────┬─────────────┘
                                                                   │ pay / request_approval
                                                                   ▼
┌───────────────────────┐  approve / reject /        ┌──────────────────────────────────┐
│ Owner (Phantom wallet)│  update_policy / allowlist │   AgentVault program (Anchor)    │
│ dashboard on phone or │ ─────────────────────────► │  Vault PDA: policy + owns USDC   │
│ laptop                │                            │  PendingPayment PDAs             │
└───────────────────────┘                            │  events → audit log              │
                                                     └────────────────┬─────────────────┘
                                                                      │ SPL transfer (PDA-signed)
                                                                      ▼
                                                           Merchant USDC accounts
```

**On-chain (`programs/agentvault`)**

- `Vault` PDA (`["vault", owner]`) stores the owner, agent, mint, limits, today's spend, allowlist (up to 8), and pause flag. It is the *authority* of the vault's USDC token account, so only the program can move funds.
- `PendingPayment` PDA (`["pending", vault, id]`) is a held payment with status Pending, Approved, or Rejected.
- Instructions:
  - Owner: `initialize`, `update_policy`, `set_merchants`, `approve`, `reject`, `withdraw`
  - Agent: `pay` (≤ threshold, settles immediately), `request_approval` (creates a PendingPayment, moves no money)
- Events: `PaymentSent`, `PaymentHeld`, `PaymentApproved`, `PaymentRejected`, `PolicyUpdated`, `MerchantsUpdated`
- The daily cap is re-checked at approval time, so approvals can't be used to blow past it.

**Off-chain (`app/`)**

- Next.js dashboard: wallet connect (Phantom), balance and daily spend, deposit, rules editor, merchant allowlist, approval queue, agent chat, and an audit log rebuilt from on-chain transaction history (including failed, blocked attempts).
- `/api/agent`: the agent loop. It uses tool calling (`get_vault_status`, `list_merchants`, `pay_merchant`) with a swappable model (`LLM_PROVIDER=gemini | anthropic | demo`). The agent sends with `skipPreflight` so blocked attempts land on-chain as an auditable record.

## Program address

| Network | Program ID |
|---|---|
| Devnet | `TODO: paste after deploy` |

## Run it yourself

Prereqs: Rust, Solana CLI, Anchor 1.2+, and Node 20+. One command installs them all:
`curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash`

```bash
# 0. Devnet wallet with SOL
solana config set --url devnet
solana-keygen new            # skip if you already have ~/.config/solana/id.json
solana airdrop 2             # or https://faucet.solana.com

# 1. Build and deploy the program
anchor keys sync             # writes YOUR program id into lib.rs and Anchor.toml
anchor build
anchor deploy --provider.cluster devnet
npm install
npm run sync-idl             # copies target/idl/agentvault.json into the app

# 2. Create the agent key + demo merchants, write app/.env.local
npm run setup

# 3. Run the dashboard
cd app
npm install
# put your free Gemini key (https://aistudio.google.com) in app/.env.local,
# or set LLM_PROVIDER=demo for a scripted agent with no API key
npm run dev
```

Then, in the browser:

1. Set Phantom to **Testnet Mode → Solana Devnet**, get devnet SOL into it from faucet.solana.com, and devnet USDC from [faucet.circle.com](https://faucet.circle.com).
2. Connect Phantom → **Create vault** (the agent key is prefilled).
3. Deposit some USDC (the Circle faucet gives 20 every 2 hours; the defaults are $10 per payment, $15 per day, approval above $5), then tick **API Credits Co** and **DataMart** in the allowlist.
4. Ask the agent to buy things. Approve held payments from the queue. On your phone, open the deployed URL inside Phantom's built-in browser.

### Deploying the dashboard (Vercel, free)

Import the repo on Vercel, set **Root Directory = `app`**, and add the env vars from `app/.env.local` (`AGENT_SECRET_KEY`, `NEXT_PUBLIC_*`, `LLM_PROVIDER`, `GEMINI_API_KEY`).

## Security notes and limits (hackathon scope)

- The agent API is unauthenticated, so anyone with the URL can ask the agent to spend. That's the point of the demo: the on-chain policy is what protects the funds. In production you'd still gate the API.
- One vault per owner, up to 8 merchants, and memos up to 64 bytes.
- Devnet only, and the program is unaudited.

## What's next

- Per-merchant limits and category budgets.
- Time-boxed session keys for agents, with spend-limited delegation that expires.
- Push notifications for approvals (Phantom deep links or Solana Actions/Blinks).
- An x402 / HTTP-402 integration, so agents can pay for APIs per request through the vault.
- Multi-agent vaults with separate budgets for each agent.

## License

MIT
