package org.pyras.thumbprint

import com.android.keyattestation.verifier.*
import com.android.keyattestation.verifier.challengecheckers.ChallengeMatcher
import com.google.protobuf.ByteString
import com.google.gson.Gson
import java.math.BigInteger
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.time.Instant
import java.util.Base64

// Runs on the relay host, never on the device whose evidence is being checked.
fun main() {
    try {
        val input = Gson().fromJson(System.`in`.reader(), Map::class.java)
        val chain = (input["certificates"] as List<*>).map {
            CertificateFactory.getInstance("X.509").generateCertificate(Base64.getDecoder().decode(it as String).inputStream()) as X509Certificate
        }
        require(chain.size in 3..8) { "Invalid attestation chain length" }
        val signer = System.getenv("THUMBPRINT_APP_SHA256") ?: error("App signing certificate fingerprint is not configured")
        require(signer.matches(Regex("[a-fA-F0-9]{64}"))) { "Invalid app signing fingerprint" }
        val expectedApp = AttestationApplicationId(
            setOf(AttestationPackageInfo("org.pyras.thumbprint", BigInteger.valueOf(2))),
            setOf(ByteString.copyFrom(signer.chunked(2).map { it.toInt(16).toByte() }.toByteArray()))
        )
        val config = constraintConfig {
            attestationApplicationId { AttestationApplicationIdConstraint.STRICT }
            additionalConstraint {
                AttributeConstraint.STRICT("Biometric-only authentication", BigInteger.valueOf(2)) { it.hardwareEnforced.userAuthType }
            }
            additionalConstraint {
                AttributeConstraint.STRICT("Authentication required", false) { it.hardwareEnforced.noAuthRequired == true || it.softwareEnforced.noAuthRequired == true }
            }
            additionalConstraint {
                // Per-operation authentication has no timeout tag, or a zero timeout.
                AttributeConstraint.STRICT("Fresh authentication for every signature", true) {
                    (it.hardwareEnforced.authTimeout == null || it.hardwareEnforced.authTimeout == BigInteger.ZERO) &&
                    (it.softwareEnforced.authTimeout == null || it.softwareEnforced.authTimeout == BigInteger.ZERO)
                }
            }
            additionalConstraint {
                AttributeConstraint.STRICT("Signing purpose", setOf(BigInteger.valueOf(2))) { it.hardwareEnforced.purposes }
            }
            additionalConstraint {
                AttributeConstraint.STRICT("P-256 curve", BigInteger.ONE) { it.hardwareEnforced.ecCurve }
            }
        }
        val result = Verifier(GoogleTrustAnchors, ::getGoogleRevocationStatusFromWeb, { Instant.now() }, expectedApp, config)
            .verify(chain, ChallengeMatcher(ByteString.copyFrom(Base64.getDecoder().decode(input["challenge"] as String))))
        require(result is VerificationResult.Success) { "Attestation rejected: $result" }
        require(result.deviceLocked && result.verifiedBootState == VerifiedBootState.VERIFIED) { "Device must have locked verified boot" }
        val key = result.publicKey as ECPublicKey
        require(key.params.curve.field.fieldSize == 256) { "Expected P-256 key" }
        val x = key.w.affineX.toString(16).padStart(64, '0').chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val compressed = byteArrayOf(if (key.w.affineY.testBit(0)) 3 else 2) + x
        val keyHex = compressed.joinToString("") { "%02x".format(it) }
        println(Gson().toJson(mapOf("ok" to true, "key" to keyHex, "securityLevel" to result.securityLevel.name, "biometricPerUse" to true, "verifiedBoot" to true)))
    } catch (e: Exception) {
        System.err.println(e.message ?: "Attestation verification failed")
        kotlin.system.exitProcess(1)
    }
}
