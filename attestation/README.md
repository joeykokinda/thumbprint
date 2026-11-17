# Off-device hardware enrollment verification

Build with `./attestation/build.sh` (JDK 21 and network access required). The
script pins Google's Android Key Attestation verifier to the commit recorded in
the script and adds our small enrollment policy entry point. It does not modify
the verifier's certificate validation implementation.

Configure `THUMBPRINT_APP_SHA256` on the server with the SHA-256 fingerprint of
the certificate signing the APK. Obtain the public fingerprint using Android's
`apksigner verify --print-certs site/thumbprint.apk`. Do not supply the APK file's
SHA-256 digest; that is a different value.

The server supplies an expiring single-use challenge, checks Google-rooted
attestation and live revocation status, the expected app package/signature,
generated hardware key origin, locked verified boot, P-256 signing purpose, and
hardware-enforced biometric-only per-operation authentication. It also verifies
possession of the exact attested key. The wallet signs the key and evidence hash;
the enrollment verifier co-signs the onchain registration. The same policy applies
to key replacement. Existing destination approvals become invalid after rotation.

The policy accepts exactly one app build: package `org.pyras.thumbprint`, version
code 2, signed by the configured certificate. Releasing a new version code means
updating `Verify.kt` and rebuilding, which is deliberate: an unknown build should
not be able to enroll a key.

The registration verifier remains trusted: the Solana program checks its
co-signature, not the Android certificate chain itself. Evidence receipts are
publicly inspectable under `/v1/enrollment/evidence/<digest>`. The evidence hash
is SHA-256 of the JSON object constructed in `server/enrollment.ts`; receipts
include the fields needed to reconstruct that object.

The deployment refuses enrollment if the verifier is missing, the signing
fingerprint is unconfigured, certificates or policies fail, or revocation status
cannot be fetched. There is no software-key enrollment override in dev mode.

References:

- [Android key attestation verification](https://developer.android.com/privacy-and-security/security-key-attestation)
- [Google verifier source](https://github.com/android/keyattestation)
- [Solana P-256 precompile](https://solana.com/docs/core/programs/precompiles)
