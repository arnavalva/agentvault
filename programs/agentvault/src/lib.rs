//! AgentVault: an on-chain spending firewall for AI agents.
//!
//! A human `owner` creates a vault that holds USDC. An AI `agent` keypair may
//! spend from it, but every payment is checked against an on-chain policy:
//!
//! * the merchant must be on the owner's allowlist,
//! * the amount must be at or under the per-transaction limit,
//! * the total spent today must stay under the daily cap,
//! * anything above the approval threshold cannot be paid directly by the
//!   agent. It becomes a `PendingPayment` that the owner approves or rejects
//!   from their wallet (e.g. Phantom on their phone).
//!
//! The agent never holds the funds. The vault PDA owns the token account, so
//! the only way money leaves is through these checks.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

// Replaced with your real program id by `anchor keys sync`.
declare_id!("63n1ep3UYAmvF5XzAd7g6fMCtdnZMQcjX2H7oovYLeK2");

pub const MAX_MERCHANTS: usize = 8;
pub const MAX_MEMO_LEN: usize = 64;
pub const SECONDS_PER_DAY: i64 = 86_400;

pub const VAULT_SEED: &[u8] = b"vault";
pub const PENDING_SEED: &[u8] = b"pending";

#[program]
pub mod agentvault {
    use super::*;

    /// Owner creates a vault, names the agent allowed to spend, and sets limits.
    pub fn initialize(
        ctx: Context<Initialize>,
        agent: Pubkey,
        per_tx_limit: u64,
        daily_cap: u64,
        approval_threshold: u64,
    ) -> Result<()> {
        validate_limits(per_tx_limit, daily_cap, approval_threshold)?;
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.agent = agent;
        vault.mint = ctx.accounts.mint.key();
        vault.per_tx_limit = per_tx_limit;
        vault.daily_cap = daily_cap;
        vault.approval_threshold = approval_threshold;
        vault.spent_today = 0;
        vault.day = current_day()?;
        vault.merchants = Vec::new();
        vault.next_payment_id = 0;
        vault.paused = false;
        vault.bump = ctx.bumps.vault;
        emit!(PolicyUpdated {
            vault: vault.key(),
            agent,
            per_tx_limit,
            daily_cap,
            approval_threshold,
            paused: false,
        });
        Ok(())
    }

    /// Owner changes the agent, the limits, or pauses all agent spending.
    pub fn update_policy(
        ctx: Context<OwnerOnly>,
        agent: Pubkey,
        per_tx_limit: u64,
        daily_cap: u64,
        approval_threshold: u64,
        paused: bool,
    ) -> Result<()> {
        validate_limits(per_tx_limit, daily_cap, approval_threshold)?;
        let vault = &mut ctx.accounts.vault;
        vault.agent = agent;
        vault.per_tx_limit = per_tx_limit;
        vault.daily_cap = daily_cap;
        vault.approval_threshold = approval_threshold;
        vault.paused = paused;
        emit!(PolicyUpdated {
            vault: vault.key(),
            agent,
            per_tx_limit,
            daily_cap,
            approval_threshold,
            paused,
        });
        Ok(())
    }

    /// Owner replaces the merchant allowlist.
    pub fn set_merchants(ctx: Context<OwnerOnly>, merchants: Vec<Pubkey>) -> Result<()> {
        require!(merchants.len() <= MAX_MERCHANTS, VaultError::TooManyMerchants);
        let vault = &mut ctx.accounts.vault;
        vault.merchants = merchants.clone();
        emit!(MerchantsUpdated {
            vault: vault.key(),
            merchants,
        });
        Ok(())
    }

    /// Agent pays an allowlisted merchant. Only allowed at or under the
    /// approval threshold; bigger payments must go through `request_approval`.
    pub fn pay(ctx: Context<Pay>, amount: u64, memo: String) -> Result<()> {
        let merchant = ctx.accounts.merchant.key();
        let vault = &mut ctx.accounts.vault;
        vault.check_agent_payment(&merchant, amount, &memo)?;
        require!(
            amount <= vault.approval_threshold,
            VaultError::NeedsApproval
        );
        vault.record_spend(amount)?;

        let owner = vault.owner;
        let bump = vault.bump;
        let vault_key = vault.key();
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token,
            &ctx.accounts.mint,
            &ctx.accounts.merchant_token,
            ctx.accounts.vault.to_account_info(),
            &owner,
            bump,
            amount,
        )?;

        emit!(PaymentSent {
            vault: vault_key,
            merchant,
            amount,
            memo,
        });
        Ok(())
    }

    /// Agent asks the owner to approve a payment above the threshold.
    /// No money moves until the owner signs `approve`.
    pub fn request_approval(ctx: Context<RequestApproval>, amount: u64, memo: String) -> Result<()> {
        let merchant = ctx.accounts.merchant.key();
        let vault = &mut ctx.accounts.vault;
        vault.check_agent_payment(&merchant, amount, &memo)?;

        let id = vault.next_payment_id;
        vault.next_payment_id = id.checked_add(1).ok_or(VaultError::Overflow)?;

        let pending = &mut ctx.accounts.pending;
        pending.vault = vault.key();
        pending.id = id;
        pending.merchant = merchant;
        pending.amount = amount;
        pending.memo = memo.clone();
        pending.created_at = Clock::get()?.unix_timestamp;
        pending.status = PaymentStatus::Pending;
        pending.bump = ctx.bumps.pending;

        emit!(PaymentHeld {
            vault: pending.vault,
            payment_id: id,
            merchant,
            amount,
            memo,
        });
        Ok(())
    }

    /// Owner approves a held payment. The daily cap is still enforced.
    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        let pending = &mut ctx.accounts.pending;
        require!(
            pending.status == PaymentStatus::Pending,
            VaultError::NotPending
        );
        let amount = pending.amount;
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.merchants.contains(&pending.merchant),
            VaultError::MerchantNotAllowed
        );
        vault.record_spend(amount)?;
        pending.status = PaymentStatus::Approved;

        let owner = vault.owner;
        let bump = vault.bump;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token,
            &ctx.accounts.mint,
            &ctx.accounts.merchant_token,
            ctx.accounts.vault.to_account_info(),
            &owner,
            bump,
            amount,
        )?;

        emit!(PaymentApproved {
            vault: ctx.accounts.vault.key(),
            payment_id: ctx.accounts.pending.id,
            merchant: ctx.accounts.pending.merchant,
            amount,
        });
        Ok(())
    }

    /// Owner rejects a held payment. Nothing is transferred.
    pub fn reject(ctx: Context<Reject>) -> Result<()> {
        let pending = &mut ctx.accounts.pending;
        require!(
            pending.status == PaymentStatus::Pending,
            VaultError::NotPending
        );
        pending.status = PaymentStatus::Rejected;
        emit!(PaymentRejected {
            vault: pending.vault,
            payment_id: pending.id,
        });
        Ok(())
    }

    /// Owner withdraws USDC from the vault back to their own wallet.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let owner = ctx.accounts.vault.owner;
        let bump = ctx.accounts.vault.bump;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token,
            &ctx.accounts.mint,
            &ctx.accounts.owner_token,
            ctx.accounts.vault.to_account_info(),
            &owner,
            bump,
            amount,
        )
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn current_day() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp / SECONDS_PER_DAY)
}

fn validate_limits(per_tx_limit: u64, daily_cap: u64, approval_threshold: u64) -> Result<()> {
    require!(
        approval_threshold <= per_tx_limit && per_tx_limit <= daily_cap,
        VaultError::InvalidPolicy
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn transfer_from_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    vault_info: AccountInfo<'info>,
    owner: &Pubkey,
    bump: u8,
    amount: u64,
) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner.as_ref(), &[bump]]];
    let cpi_accounts = TransferChecked {
        from: from.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: vault_info,
    };
    let cpi_ctx = CpiContext::new_with_signer(token_program.key(), cpi_accounts, signer_seeds);
    token_interface::transfer_checked(cpi_ctx, amount, mint.decimals)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub per_tx_limit: u64,
    pub daily_cap: u64,
    pub approval_threshold: u64,
    pub spent_today: u64,
    /// Day number (unix time / 86400) that `spent_today` refers to.
    pub day: i64,
    #[max_len(MAX_MERCHANTS)]
    pub merchants: Vec<Pubkey>,
    pub next_payment_id: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Vault {
    /// Checks every rule that applies to an agent-initiated payment.
    fn check_agent_payment(&self, merchant: &Pubkey, amount: u64, memo: &str) -> Result<()> {
        require!(!self.paused, VaultError::Paused);
        require!(amount > 0, VaultError::ZeroAmount);
        require!(memo.len() <= MAX_MEMO_LEN, VaultError::MemoTooLong);
        require!(
            self.merchants.contains(merchant),
            VaultError::MerchantNotAllowed
        );
        require!(
            amount <= self.per_tx_limit,
            VaultError::OverPerTxLimit
        );
        Ok(())
    }

    /// Rolls the daily window if needed, then enforces and records the cap.
    fn record_spend(&mut self, amount: u64) -> Result<()> {
        let today = current_day()?;
        if today != self.day {
            self.day = today;
            self.spent_today = 0;
        }
        let new_total = self
            .spent_today
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        require!(new_total <= self.daily_cap, VaultError::OverDailyCap);
        self.spent_today = new_total;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum PaymentStatus {
    Pending,
    Approved,
    Rejected,
}

#[account]
#[derive(InitSpace)]
pub struct PendingPayment {
    pub vault: Pubkey,
    pub id: u64,
    pub merchant: Pubkey,
    pub amount: u64,
    #[max_len(MAX_MEMO_LEN)]
    pub memo: String,
    pub created_at: i64,
    pub status: PaymentStatus,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ VaultError::NotOwner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(
        mut,
        has_one = agent @ VaultError::NotAgent,
        has_one = mint,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: only used as the payee address; checked against the allowlist.
    pub merchant: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = merchant,
        associated_token::token_program = token_program,
    )]
    pub merchant_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RequestApproval<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(
        mut,
        has_one = agent @ VaultError::NotAgent,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: only used as the payee address; checked against the allowlist.
    pub merchant: UncheckedAccount<'info>,
    #[account(
        init,
        payer = agent,
        space = 8 + PendingPayment::INIT_SPACE,
        seeds = [PENDING_SEED, vault.key().as_ref(), &vault.next_payment_id.to_le_bytes()],
        bump,
    )]
    pub pending: Account<'info, PendingPayment>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ VaultError::NotOwner,
        has_one = mint,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        has_one = vault,
        has_one = merchant,
        seeds = [PENDING_SEED, vault.key().as_ref(), &pending.id.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Account<'info, PendingPayment>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: must equal `pending.merchant` (enforced by `has_one` above).
    pub merchant: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = merchant,
        associated_token::token_program = token_program,
    )]
    pub merchant_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Reject<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ VaultError::NotOwner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        has_one = vault,
        seeds = [PENDING_SEED, vault.key().as_ref(), &pending.id.to_le_bytes()],
        bump = pending.bump,
    )]
    pub pending: Account<'info, PendingPayment>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ VaultError::NotOwner,
        has_one = mint,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub per_tx_limit: u64,
    pub daily_cap: u64,
    pub approval_threshold: u64,
    pub paused: bool,
}

#[event]
pub struct MerchantsUpdated {
    pub vault: Pubkey,
    pub merchants: Vec<Pubkey>,
}

#[event]
pub struct PaymentSent {
    pub vault: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub memo: String,
}

#[event]
pub struct PaymentHeld {
    pub vault: Pubkey,
    pub payment_id: u64,
    pub merchant: Pubkey,
    pub amount: u64,
    pub memo: String,
}

#[event]
pub struct PaymentApproved {
    pub vault: Pubkey,
    pub payment_id: u64,
    pub merchant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PaymentRejected {
    pub vault: Pubkey,
    pub payment_id: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Merchant is not on the vault's allowlist")]
    MerchantNotAllowed,
    #[msg("Amount exceeds the per-transaction limit")]
    OverPerTxLimit,
    #[msg("Payment would exceed the daily spending cap")]
    OverDailyCap,
    #[msg("Amount is above the approval threshold; request owner approval")]
    NeedsApproval,
    #[msg("Agent spending is paused by the owner")]
    Paused,
    #[msg("Signer is not this vault's agent")]
    NotAgent,
    #[msg("Signer is not this vault's owner")]
    NotOwner,
    #[msg("Payment is not pending")]
    NotPending,
    #[msg("Limits must satisfy threshold <= per-tx limit <= daily cap")]
    InvalidPolicy,
    #[msg("Too many merchants (max 8)")]
    TooManyMerchants,
    #[msg("Memo too long (max 64 bytes)")]
    MemoTooLong,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
}
