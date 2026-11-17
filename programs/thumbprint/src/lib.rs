use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    hash::hash,
    program_option::COption,
    sysvar::instructions::{
        load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
    },
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, StateWithExtensions},
    state::{Account as TokenAccount, Mint},
};
use spl_token_group_interface::state::TokenGroupMember;

declare_id!("EerbNxsSbeADJLet2sYBZwC9eKmQPYDv3UaohaMRmriS");

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
pub const P256_PROGRAM: Pubkey = pubkey!("Secp256r1SigVerify1111111111111111111111111");
pub const MAX_AUTHORIZATION_SECONDS: i64 = 7 * 86400;

pub fn domain() -> String {
    let network = if cfg!(feature = "devnet") {
        "devnet"
    } else {
        "localnet"
    };
    format!("Thumbprint v2 | {network} | {}", crate::ID)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hardware_message(handle: &str, key: &[u8; 33], evidence: &[u8; 32], count: u64) -> String {
    format!(
        "{}\nEnroll biometric key for {handle}\nKey: {}\nEvidence: {}\nCounter: {count}",
        domain(),
        hex(key),
        hex(evidence)
    )
}
pub fn destination_message(
    handle: &str,
    address: &Pubkey,
    expires: i64,
    enabled: bool,
    count: u64,
) -> String {
    let action = if enabled { "Approve" } else { "Revoke" };
    format!("{}\n{action} treasury payments for {handle}\nRecipient: {address}\nExpires: {expires}\nCounter: {count}", domain())
}

#[program]
pub mod thumbprint {
    use super::*;

    // The Seed Vault wallet only signs transactions for the network it is set to, and the
    // Genesis Token lives on mainnet. So every action is a readable signed message, verified by
    // a signature-check instruction placed directly before ours in the same transaction:
    // the wallet (Ed25519) for linking and key enrollment, the attested fingerprint key (P-256)
    // for everything else. Anyone may pay for and submit the transaction.

    /// One device, one handle. `handle` is "platform:name", lowercase, e.g. "x:someone".
    // ponytail: one trusted verifier key vouches for control of the social account.
    // Upgrade path: several independent verifiers, or a zkTLS proof of the post checked here.
    ///
    /// `approver` is kept for the wallet message and account layout only. Nothing can be
    /// approved until `enroll_hardware` registers an attested fingerprint key.
    pub fn bind(ctx: Context<Bind>, handle: String, approver: Pubkey) -> Result<()> {
        require!(is_valid_handle(&handle), ThumbprintError::InvalidHandle);
        let message = signed_message(&ctx.accounts.instructions, ctx.accounts.owner.key)?;
        require!(
            message == bind_message(&handle, &approver).as_bytes(),
            ThumbprintError::WrongMessage
        );
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        ctx.accounts.device.owner = ctx.accounts.owner.key();
        ctx.accounts.device.approver = approver;
        ctx.accounts.device.handle = handle.clone();
        ctx.accounts.handle_claim.sgt_mint = ctx.accounts.sgt_mint.key();
        emit!(Bound {
            handle,
            owner: ctx.accounts.owner.key(),
            sgt_mint: ctx.accounts.sgt_mint.key(),
        });
        Ok(())
    }

    /// Records that the enrolled fingerprint key approved one exact post. The key signs the post
    /// text itself and the hash recorded here is computed from that signed text. The counter
    /// makes each signature single use, so a captured approval cannot be submitted again later
    /// to make an old approval look fresh.
    pub fn attest(ctx: Context<Act>) -> Result<()> {
        let message = hardware_signature(&ctx.accounts.instructions, &ctx.accounts.hardware.key)?;
        let device = &mut ctx.accounts.device;
        let prefix = attest_prefix(&device.handle, device.flag_count);
        let text = message
            .strip_prefix(prefix.as_bytes())
            .ok_or(ThumbprintError::WrongMessage)?;
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        device.flag_count = device
            .flag_count
            .checked_add(1)
            .ok_or(ThumbprintError::CounterOverflow)?;
        emit!(Attested {
            handle: device.handle.clone(),
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
    pub fn set_compromised(ctx: Context<Flag>, compromised: bool) -> Result<()> {
        let message = hardware_signature(&ctx.accounts.instructions, &ctx.accounts.hardware.key)?;
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
        device.flag_count = device
            .flag_count
            .checked_add(1)
            .ok_or(ThumbprintError::CounterOverflow)?;
        ctx.accounts.status.compromised = compromised;
        emit!(Flagged {
            handle: device.handle.clone(),
            compromised,
            owner: ctx.accounts.owner.key(),
            sgt_mint: ctx.accounts.sgt_mint.key(),
        });
        Ok(())
    }

    /// The verifier validates Android attestation and possession off-device before co-signing.
    /// The owner also signs the exact key and evidence digest, preventing relay substitution.
    pub fn enroll_hardware(
        ctx: Context<EnrollHardware>,
        key: [u8; 33],
        evidence: [u8; 32],
    ) -> Result<()> {
        require!(
            key[0] == 2 || key[0] == 3,
            ThumbprintError::HardwareRequired
        );
        let device = &mut ctx.accounts.device;
        let message = signed_message(&ctx.accounts.instructions, ctx.accounts.owner.key)?;
        require!(
            message
                == hardware_message(&device.handle, &key, &evidence, device.flag_count).as_bytes(),
            ThumbprintError::WrongMessage
        );
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        device.flag_count = device
            .flag_count
            .checked_add(1)
            .ok_or(ThumbprintError::CounterOverflow)?;
        let hardware = &mut ctx.accounts.hardware;
        hardware.key = key;
        hardware.evidence = evidence;
        hardware.generation = device.flag_count;
        emit!(HardwareEnrolled {
            handle: device.handle.clone(),
            key,
            evidence,
            generation: hardware.generation
        });
        Ok(())
    }

    pub fn set_destination(
        ctx: Context<SetDestination>,
        recipient: Pubkey,
        expires_at: i64,
        enabled: bool,
    ) -> Result<()> {
        let device = &mut ctx.accounts.device;
        let message = hardware_signature(&ctx.accounts.instructions, &ctx.accounts.hardware.key)?;
        require!(
            message
                == destination_message(
                    &device.handle,
                    &recipient,
                    expires_at,
                    enabled,
                    device.flag_count
                )
                .as_bytes(),
            ThumbprintError::WrongMessage
        );
        verify_sgt(
            ctx.accounts.owner.key,
            &ctx.accounts.sgt_token_account,
            &ctx.accounts.sgt_mint,
        )?;
        let now = Clock::get()?.unix_timestamp;
        if enabled {
            require!(
                recipient != Pubkey::default()
                    && expires_at > now
                    && expires_at <= now + MAX_AUTHORIZATION_SECONDS,
                ThumbprintError::InvalidExpiry
            );
        } else {
            require_keys_eq!(
                recipient,
                ctx.accounts.authorization.recipient,
                ThumbprintError::WrongRecipient
            );
        }
        let authorization = &mut ctx.accounts.authorization;
        authorization.recipient = recipient;
        authorization.expires_at = expires_at;
        authorization.enabled = enabled;
        authorization.generation = ctx.accounts.hardware.generation;
        authorization.approved_at = now;
        authorization.handle = device.handle.clone();
        device.flag_count = device
            .flag_count
            .checked_add(1)
            .ok_or(ThumbprintError::CounterOverflow)?;
        emit!(DestinationSet {
            handle: device.handle.clone(),
            recipient,
            expires_at,
            enabled,
            generation: authorization.generation
        });
        Ok(())
    }

    /// Validation and the actual transfer share the same recipient account and instruction.
    pub fn pay(ctx: Context<Pay>, _handle: String, lamports: u64) -> Result<()> {
        let authorization = &ctx.accounts.authorization;
        require!(authorization.enabled, ThumbprintError::Revoked);
        require!(
            authorization.expires_at > Clock::get()?.unix_timestamp,
            ThumbprintError::Expired
        );
        require!(
            authorization.generation == ctx.accounts.hardware.generation,
            ThumbprintError::KeyChanged
        );
        require_keys_eq!(
            authorization.recipient,
            ctx.accounts.recipient.key(),
            ThumbprintError::WrongRecipient
        );
        if !ctx.accounts.status.data_is_empty() {
            require_keys_eq!(
                *ctx.accounts.status.owner,
                crate::ID,
                ThumbprintError::ReportedCompromised
            );
            let status = Status::try_deserialize(&mut &ctx.accounts.status.try_borrow_data()?[..])?;
            require!(!status.compromised, ThumbprintError::ReportedCompromised);
        }
        require!(lamports > 0, ThumbprintError::InvalidAmount);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
            ),
            lamports,
        )?;
        emit!(Paid {
            handle: authorization.handle.clone(),
            recipient: authorization.recipient,
            payer: ctx.accounts.payer.key(),
            lamports
        });
        Ok(())
    }
}

// The wallet shows these to the owner, so they are written to be read. The phone page builds
// the same strings; tests/thumbprint.ts pins them.
pub fn bind_message(handle: &str, approver: &Pubkey) -> String {
    format!("Thumbprint: link {handle} to this Seeker\nPosts are approved by key {approver}")
}
pub fn attest_prefix(handle: &str, count: u64) -> String {
    format!("{}\nApprove post as {handle} (#{count})\n\n", domain())
}
pub fn flag_message(handle: &str, compromised: bool, count: u64) -> String {
    let state = if compromised {
        "compromised"
    } else {
        "recovered"
    };
    format!("{}\nReport {handle} as {state} (#{count})", domain())
}

/// Returns the message the wallet `owner` signed, taken from the Ed25519 program instruction placed
/// directly before this one. That program has already verified the signature by the time we run.
fn signed_message(instructions: &AccountInfo, owner: &Pubkey) -> Result<Vec<u8>> {
    let index = load_current_index_checked(instructions)? as usize;
    require!(index > 0, ThumbprintError::NotSigned);
    let instruction = load_instruction_at_checked(index - 1, instructions)?;
    require_keys_eq!(
        instruction.program_id,
        ed25519_program::ID,
        ThumbprintError::NotSigned
    );
    let data = &instruction.data;
    // Layout: count u8, padding u8, then u16 fields: signature offset, signature instruction,
    // key offset, key instruction, message offset, message size, message instruction.
    let field = |at: usize| -> Option<usize> {
        Some(u16::from_le_bytes([*data.get(at)?, *data.get(at + 1)?]) as usize)
    };
    let parsed = (|| {
        let inline = u16::MAX as usize; // every part must live in this same instruction
        if *data.first()? != 1 || field(4)? != inline || field(8)? != inline || field(14)? != inline
        {
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

/// The same for the fingerprint key: the message `key` signed, from the P-256 precompile
/// instruction placed directly before this one.
fn hardware_signature(instructions: &AccountInfo, key: &[u8; 33]) -> Result<Vec<u8>> {
    let index = load_current_index_checked(instructions)? as usize;
    require!(index > 0, ThumbprintError::NotSigned);
    let ix = load_instruction_at_checked(index - 1, instructions)?;
    require_keys_eq!(ix.program_id, P256_PROGRAM, ThumbprintError::NotSigned);
    let data = ix.data;
    let field = |at: usize| -> Option<usize> {
        Some(u16::from_le_bytes([*data.get(at)?, *data.get(at + 1)?]) as usize)
    };
    let parsed = (|| {
        if *data.first()? != 1 || field(4)? != 65535 || field(8)? != 65535 || field(14)? != 65535 {
            return None;
        }
        let key_offset = field(6)?;
        let offset = field(10)?;
        if data.get(key_offset..key_offset + 33)? != key {
            return None;
        }
        Some(data.get(offset..offset + field(12)?)?.to_vec())
    })();
    parsed.ok_or_else(|| error!(ThumbprintError::NotSigned))
}

pub fn is_valid_handle(handle: &str) -> bool {
    let Some((platform, name)) = handle.split_once(':') else {
        return false;
    };
    let allowed = |text: &str| {
        !text.is_empty()
            && text.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'.'
            })
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
    require_keys_eq!(
        *token_account.owner,
        spl_token_2022::ID,
        ThumbprintError::NotSeeker
    );
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
    /// CHECK: tied to the device by has_one; the action itself is signed by the hardware key
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"device", sgt_mint.key().as_ref()], bump, has_one = owner @ ThumbprintError::NotOwner)]
    pub device: Account<'info, Device>,
    #[account(seeds = [b"hardware", device.key().as_ref()], bump)]
    pub hardware: Account<'info, Hardware>,
    /// CHECK: the instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Flag<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: tied to the device by has_one; the action itself is signed by the hardware key
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"device", sgt_mint.key().as_ref()], bump, has_one = owner @ ThumbprintError::NotOwner)]
    pub device: Account<'info, Device>,
    #[account(seeds = [b"hardware", device.key().as_ref()], bump)]
    pub hardware: Account<'info, Hardware>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Status::INIT_SPACE,
        seeds = [b"status", device.handle.as_bytes()],
        bump
    )]
    pub status: Account<'info, Status>,
    /// CHECK: the instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnrollHardware<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = VERIFIER @ ThumbprintError::NotVerified)]
    pub verifier: Signer<'info>,
    /// CHECK: authenticated by wallet message signature
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"device", sgt_mint.key().as_ref()], bump, has_one = owner @ ThumbprintError::NotOwner)]
    pub device: Account<'info, Device>,
    #[account(init_if_needed, payer = payer, space = 8 + Hardware::INIT_SPACE, seeds = [b"hardware", device.key().as_ref()], bump)]
    pub hardware: Account<'info, Hardware>,
    /// CHECK: instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDestination<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: device.has_one binds this owner; attested key signs the message
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: validated in verify_sgt
    pub sgt_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"device", sgt_mint.key().as_ref()], bump, has_one = owner @ ThumbprintError::NotOwner)]
    pub device: Account<'info, Device>,
    #[account(seeds = [b"hardware", device.key().as_ref()], bump)]
    pub hardware: Account<'info, Hardware>,
    #[account(init_if_needed, payer = payer, space = 8 + Authorization::INIT_SPACE, seeds = [b"treasury", device.handle.as_bytes()], bump)]
    pub authorization: Account<'info, Authorization>,
    /// CHECK: instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(handle: String)]
pub struct Pay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: recipient is matched to the authorization before transfer
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    #[account(seeds = [b"handle", handle.as_bytes()], bump)]
    pub handle_claim: Account<'info, HandleClaim>,
    #[account(seeds = [b"device", handle_claim.sgt_mint.as_ref()], bump)]
    pub device: Account<'info, Device>,
    #[account(seeds = [b"hardware", device.key().as_ref()], bump)]
    pub hardware: Account<'info, Hardware>,
    #[account(seeds = [b"treasury", handle.as_bytes()], bump, constraint = authorization.handle == handle @ ThumbprintError::WrongMessage)]
    pub authorization: Account<'info, Authorization>,
    /// CHECK: optional account until the first report; owner and discriminator checked in pay
    #[account(seeds = [b"status", handle.as_bytes()], bump)]
    pub status: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Hardware {
    pub key: [u8; 33],
    pub evidence: [u8; 32],
    pub generation: u64,
}
#[account]
#[derive(InitSpace)]
pub struct Authorization {
    pub recipient: Pubkey,
    pub expires_at: i64,
    pub enabled: bool,
    pub generation: u64,
    pub approved_at: i64,
    #[max_len(MAX_HANDLE_LEN)]
    pub handle: String,
}
#[event]
pub struct HardwareEnrolled {
    pub handle: String,
    pub key: [u8; 33],
    pub evidence: [u8; 32],
    pub generation: u64,
}
#[event]
pub struct DestinationSet {
    pub handle: String,
    pub recipient: Pubkey,
    pub expires_at: i64,
    pub enabled: bool,
    pub generation: u64,
}
#[event]
pub struct Paid {
    pub handle: String,
    pub recipient: Pubkey,
    pub payer: Pubkey,
    pub lamports: u64,
}

/// Whether the owner has reported the handle as taken over. Seeds ["status", handle], so any
/// program that knows the handle can read it. Absent means never reported.
#[account]
#[derive(InitSpace)]
pub struct Status {
    pub compromised: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Device {
    /// The wallet that linked this device. Only it can enroll or replace the fingerprint key.
    pub owner: Pubkey,
    /// Unused since approvals moved to the attested key in `Hardware`; kept for account layout.
    pub approver: Pubkey,
    #[max_len(MAX_HANDLE_LEN)]
    pub handle: String,
    /// One counter for every signed action (posts, destinations, suspension, key enrollment),
    /// so no signature can be used twice.
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
    #[msg("Enroll a verified biometric hardware key first")]
    HardwareRequired,
    #[msg("Authorization expiry must be in the future and within seven days")]
    InvalidExpiry,
    #[msg("The actual payment recipient does not match the approved recipient")]
    WrongRecipient,
    #[msg("This destination approval has been revoked")]
    Revoked,
    #[msg("This destination approval has expired")]
    Expired,
    #[msg("Approve the destination again after changing the hardware key")]
    KeyChanged,
    #[msg("Payment amount must be positive")]
    InvalidAmount,
    #[msg("Action counter exhausted")]
    CounterOverflow,

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
    #[msg("This device was linked by a different wallet")]
    NotOwner,
    #[msg("The owner reported this account as taken over")]
    ReportedCompromised,
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
