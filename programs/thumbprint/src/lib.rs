use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, StateWithExtensions},
    state::{Account as TokenAccount, Mint},
};
use spl_token_group_interface::state::TokenGroupMember;

declare_id!("6RWoM23c88jAcnvgPkierPcypWu2mTEtVw3Z4vN73J9s");

// Seeker Genesis Token group, from docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token
pub const SGT_GROUP: Pubkey = pubkey!("GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te");
pub const SGT_MINT_AUTHORITY: Pubkey = pubkey!("GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4");

pub const MAX_HANDLE_LEN: usize = 32;

#[program]
pub mod thumbprint {
    use super::*;

    /// One device, one handle. `handle` is "platform:name", lowercase, e.g. "x:someone".
    // ponytail: first claim wins, control of the social account is not proven onchain.
    // Upgrade path: require a verifier signature over a proof post before a handle counts as protected.
    pub fn bind(ctx: Context<Bind>, handle: String) -> Result<()> {
        require!(is_valid_handle(&handle), ThumbprintError::InvalidHandle);
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        ctx.accounts.device.handle = handle.clone();
        ctx.accounts.handle_claim.sgt_mint = ctx.accounts.sgt_mint.key();
        emit!(Bound {
            handle,
            owner: ctx.accounts.owner.key(),
            sgt_mint: ctx.accounts.sgt_mint.key(),
        });
        Ok(())
    }

    /// Records that the device bound to a handle approved one exact post.
    /// `text_hash` is sha256 of the normalized post text, computed by the client.
    pub fn attest(ctx: Context<Attest>, text_hash: [u8; 32]) -> Result<()> {
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        emit!(Attested {
            handle: ctx.accounts.device.handle.clone(),
            text_hash,
            owner: ctx.accounts.owner.key(),
            sgt_mint: ctx.accounts.sgt_mint.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

pub fn is_valid_handle(handle: &str) -> bool {
    let Some((platform, name)) = handle.split_once(':') else {
        return false;
    };
    let allowed = |text: &str| {
        !text.is_empty()
            && text
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'.')
    };
    handle.len() <= MAX_HANDLE_LEN && allowed(platform) && allowed(name)
}

/// The signer must hold exactly one token of a mint that is a member of the
/// Seeker Genesis Token group. Membership can only be written by the group's
/// update authority, so a self-made mint cannot pass.
fn verify_sgt(owner: &Pubkey, token_account: &AccountInfo, mint: &AccountInfo) -> Result<()> {
    // ponytail: the token only exists on mainnet, so the devnet build skips this and the
    // indexer runs the same check over mainnet RPC using `owner` and `sgt_mint` from the event.
    // Upgrade path: deploy to mainnet without the feature.
    if cfg!(feature = "devnet") {
        return Ok(());
    }
    require_keys_eq!(*token_account.owner, spl_token_2022::ID, ThumbprintError::NotSeeker);
    require_keys_eq!(*mint.owner, spl_token_2022::ID, ThumbprintError::NotSeeker);

    let token_data = token_account.try_borrow_data()?;
    let token = StateWithExtensions::<TokenAccount>::unpack(&token_data)
        .map_err(|_| ThumbprintError::NotSeeker)?;
    require!(
        token.base.owner == *owner && token.base.mint == mint.key() && token.base.amount == 1,
        ThumbprintError::NotSeeker
    );

    let mint_data = mint.try_borrow_data()?;
    let mint_state =
        StateWithExtensions::<Mint>::unpack(&mint_data).map_err(|_| ThumbprintError::NotSeeker)?;
    require!(
        mint_state.base.mint_authority == COption::Some(SGT_MINT_AUTHORITY),
        ThumbprintError::NotSeeker
    );
    let member = mint_state
        .get_extension::<TokenGroupMember>()
        .map_err(|_| ThumbprintError::NotSeeker)?;
    require!(
        member.group == SGT_GROUP && member.mint == mint.key(),
        ThumbprintError::NotSeeker
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(handle: String)]
pub struct Bind<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Device::INIT_SPACE,
        seeds = [b"device", sgt_mint.key().as_ref()],
        bump
    )]
    pub device: Account<'info, Device>,
    #[account(
        init,
        payer = payer,
        space = 8 + HandleClaim::INIT_SPACE,
        seeds = [b"handle", handle.as_bytes()],
        bump
    )]
    pub handle_claim: Account<'info, HandleClaim>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Attest<'info> {
    pub owner: Signer<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_mint: UncheckedAccount<'info>,
    #[account(seeds = [b"device", sgt_mint.key().as_ref()], bump)]
    pub device: Account<'info, Device>,
}

#[account]
#[derive(InitSpace)]
pub struct Device {
    #[max_len(MAX_HANDLE_LEN)]
    pub handle: String,
}

#[account]
#[derive(InitSpace)]
pub struct HandleClaim {
    pub sgt_mint: Pubkey,
}

#[event]
pub struct Bound {
    pub handle: String,
    pub owner: Pubkey,
    pub sgt_mint: Pubkey,
}

#[event]
pub struct Attested {
    pub handle: String,
    pub text_hash: [u8; 32],
    pub owner: Pubkey,
    pub sgt_mint: Pubkey,
    pub timestamp: i64,
}

#[error_code]
pub enum ThumbprintError {
    #[msg("Signer does not hold a Seeker Genesis Token")]
    NotSeeker,
    #[msg("Handle must be platform:name using a-z, 0-9, underscore or dot, at most 32 bytes")]
    InvalidHandle,
}

#[cfg(test)]
mod tests {
    use super::is_valid_handle;

    #[test]
    fn handle_rules() {
        assert!(is_valid_handle("x:some_one.1"));
        assert!(!is_valid_handle("x:Upper"));
        assert!(!is_valid_handle("nocolon"));
        assert!(!is_valid_handle("x:"));
        assert!(!is_valid_handle(":name"));
        assert!(!is_valid_handle("x:a:b"));
        assert!(!is_valid_handle(&format!("x:{}", "a".repeat(31))));
    }
}
