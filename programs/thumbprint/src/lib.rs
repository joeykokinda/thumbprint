use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    hash::hash,
    program_option::COption,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID},
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, StateWithExtensions},
    state::{Account as TokenAccount, Mint},
};
use spl_token_group_interface::state::TokenGroupMember;

declare_id!("BYeu5eZoiHT7JWYbaECxWdi3awPKMoZspYnnEN5uHUjc");

// Seeker Genesis Token group, from docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token
pub const SGT_GROUP: Pubkey = pubkey!("GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te");
pub const SGT_MINT_AUTHORITY: Pubkey = pubkey!("GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4");

// Linking a handle needs this key's signature. The Thumbprint server holds it and only signs
// after it has seen a public post from that handle carrying the device's code, so a handle
// cannot be claimed by someone who does not control the account.
#[cfg(feature = "devnet")]
pub const VERIFIER: Pubkey = pubkey!("5RPLUJsvTDjPzwk6eB9169ixMk1mvydvD2Nwy9hzxm6z");
#[cfg(not(feature = "devnet"))]
pub const VERIFIER: Pubkey = pubkey!("4VrKHHLAsJTtjDaKGNHbNfBNoTt5Q5jezwNZv8Vme8Z8"); // tests/fixtures/verifier.json

pub const MAX_HANDLE_LEN: usize = 32;

#[program]
pub mod thumbprint {
    use super::*;

    // The Seed Vault wallet only signs transactions for the network it is set to, and the
    // Genesis Token lives on mainnet. So the device signs a readable message instead, and every
    // instruction here checks that signature through the Ed25519 program in the same transaction.
    // Anyone may pay for and submit the transaction; only the device can produce the message.

    /// One device, one handle. `handle` is "platform:name", lowercase, e.g. "x:someone".
    // ponytail: one trusted verifier key vouches for control of the social account.
    // Upgrade path: several independent verifiers, or a zkTLS proof of the post checked here.
    pub fn bind(ctx: Context<Bind>, handle: String) -> Result<()> {
        require!(is_valid_handle(&handle), ThumbprintError::InvalidHandle);
        let message = signed_message(&ctx.accounts.instructions, ctx.accounts.owner.key)?;
        require!(message == bind_message(&handle).as_bytes(), ThumbprintError::WrongMessage);
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

    /// Records that the device bound to a handle approved one exact post. The device signs the
    /// post text itself, and the hash recorded here is computed from that signed text.
    pub fn attest(ctx: Context<Act>) -> Result<()> {
        let message = signed_message(&ctx.accounts.instructions, ctx.accounts.owner.key)?;
        let prefix = attest_prefix(&ctx.accounts.device.handle);
        let text = message
            .strip_prefix(prefix.as_bytes())
            .ok_or(ThumbprintError::WrongMessage)?;
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        emit!(Attested {
            handle: ctx.accounts.device.handle.clone(),
            text_hash: hash(text).to_bytes(),
            owner: ctx.accounts.owner.key(),
            sgt_mint: ctx.accounts.sgt_mint.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Kill switch: the device owner marks the handle as compromised (or clears it).
    /// Works while an attacker holds the social account, because it needs only the device.
    /// The counter in the message stops an old "recovered" signature from being replayed.
    pub fn set_compromised(ctx: Context<Act>, compromised: bool) -> Result<()> {
        let message = signed_message(&ctx.accounts.instructions, ctx.accounts.owner.key)?;
        let device = &mut ctx.accounts.device;
        require!(
            message == flag_message(&device.handle, compromised, device.flag_count).as_bytes(),
            ThumbprintError::WrongMessage
        );
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        device.flag_count += 1;
        emit!(Flagged {
            handle: device.handle.clone(),
            compromised,
            owner: ctx.accounts.owner.key(),
            sgt_mint: ctx.accounts.sgt_mint.key(),
        });
        Ok(())
    }
}

// The wallet shows these to the owner, so they are written to be read. The phone page builds
// the same strings; tests/thumbprint.ts pins them.
pub fn bind_message(handle: &str) -> String {
    format!("Thumbprint: link {handle} to this Seeker")
}
pub fn attest_prefix(handle: &str) -> String {
    format!("Thumbprint: approve this post as {handle}\n\n")
}
pub fn flag_message(handle: &str, compromised: bool, count: u64) -> String {
    let state = if compromised { "compromised" } else { "recovered" };
    format!("Thumbprint: report {handle} as {state} (#{count})")
}

/// Returns the message that `owner` signed, taken from the Ed25519 program instruction placed
/// directly before this one. That program has already verified the signature by the time we run.
fn signed_message(instructions: &AccountInfo, owner: &Pubkey) -> Result<Vec<u8>> {
    let index = load_current_index_checked(instructions)? as usize;
    require!(index > 0, ThumbprintError::NotSigned);
    let instruction = load_instruction_at_checked(index - 1, instructions)?;
    require_keys_eq!(instruction.program_id, ed25519_program::ID, ThumbprintError::NotSigned);
    let data = &instruction.data;
    // Layout: count u8, padding u8, then u16 fields: signature offset, signature instruction,
    // key offset, key instruction, message offset, message size, message instruction.
    let field = |at: usize| -> Option<usize> {
        Some(u16::from_le_bytes([*data.get(at)?, *data.get(at + 1)?]) as usize)
    };
    let parsed = (|| {
        let inline = u16::MAX as usize; // every part must live in this same instruction
        if *data.first()? != 1 || field(4)? != inline || field(8)? != inline || field(14)? != inline {
            return None;
        }
        let key_offset = field(6)?;
        let message_offset = field(10)?;
        let key = data.get(key_offset..key_offset + 32)?;
        let message = data.get(message_offset..message_offset + field(12)?)?;
        (key == owner.as_ref()).then(|| message.to_vec())
    })();
    parsed.ok_or_else(|| error!(ThumbprintError::NotSigned))
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
    #[account(address = VERIFIER @ ThumbprintError::NotVerified)]
    pub verifier: Signer<'info>,
    /// CHECK: proven by the Ed25519 instruction, see signed_message
    pub owner: UncheckedAccount<'info>,
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
    /// CHECK: the instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Act<'info> {
    /// CHECK: proven by the Ed25519 instruction, see signed_message
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"device", sgt_mint.key().as_ref()], bump)]
    pub device: Account<'info, Device>,
    /// CHECK: the instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Device {
    #[max_len(MAX_HANDLE_LEN)]
    pub handle: String,
    pub flag_count: u64,
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

#[event]
pub struct Flagged {
    pub handle: String,
    pub compromised: bool,
    pub owner: Pubkey,
    pub sgt_mint: Pubkey,
}

#[error_code]
pub enum ThumbprintError {
    #[msg("Signer does not hold a Seeker Genesis Token")]
    NotSeeker,
    #[msg("The device did not sign this action")]
    NotSigned,
    #[msg("The signed message does not match this action")]
    WrongMessage,
    #[msg("Handle must be platform:name using a-z, 0-9, underscore or dot, at most 32 bytes")]
    InvalidHandle,
    #[msg("Linking a handle needs the verifier's signature")]
    NotVerified,
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
