package org.pyras.thumbprint;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import org.json.JSONObject;

// The Thumbprint app: the phone page in a WebView, plus the one thing a web page cannot have,
// an Ed25519 key that lives in the phone's secure hardware and signs only after a fingerprint.
// No PIN or pattern can stand in for it, and adding a fingerprint to the phone destroys it.
public class MainActivity extends Activity {
    static final String ORIGIN = "https://thumbprint.pyras.org";
    static final String KEY_ALIAS = "approval";
    WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Key(), "ThumbprintKey");
        web.setWebViewClient(new WebViewClient() {
            // The key is exposed to script, so only our own page may ever load here.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request.getUrl().toString().startsWith(ORIGIN + "/phone")) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                return true;
            }
        });
        setContentView(web);
        open(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) open(intent);
    }

    // thumbprint://phone?session=...&owner=... carries the pairing code and, after linking, the wallet.
    void open(Intent intent) {
        Uri data = intent.getData();
        String query = data != null && data.getEncodedQuery() != null ? "?" + data.getEncodedQuery() : "";
        web.loadUrl(ORIGIN + "/phone" + query);
    }

    KeyStore store() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    void reply(String signature, String error) {
        web.evaluateJavascript("thumbprintSigned(" + JSONObject.quote(signature) + "," + JSONObject.quote(error) + ")", null);
    }

    void sign(final String message) {
        final Signature signature;
        try {
            signature = Signature.getInstance("Ed25519");
            signature.initSign((PrivateKey) store().getKey(KEY_ALIAS, null));
        } catch (KeyPermanentlyInvalidatedException changed) {
            try { store().deleteEntry(KEY_ALIAS); } catch (Exception ignored) { }
            reply("", "The fingerprints on this phone changed. Open the app again and link this Seeker once more.");
            return;
        } catch (Exception error) {
            Log.e("Thumbprint", "sign", error);
            reply("", "Could not use the fingerprint key.");
            return;
        }
        // The system draws this prompt, not the page, so the words on it are the words signed.
        new BiometricPrompt.Builder(this)
            .setTitle("Approve with your fingerprint")
            .setDescription(message)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButton("Cancel", getMainExecutor(), (dialog, which) -> reply("", "Cancelled."))
            .build()
            .authenticate(new BiometricPrompt.CryptoObject(signature), new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    try {
                        Signature unlocked = result.getCryptoObject().getSignature();
                        unlocked.update(message.getBytes(StandardCharsets.UTF_8));
                        reply(Base64.encodeToString(unlocked.sign(), Base64.NO_WRAP), "");
                    } catch (Exception error) {
                        Log.e("Thumbprint", "sign", error);
                        reply("", "Could not sign.");
                    }
                }

                @Override
                public void onAuthenticationError(int code, CharSequence text) {
                    reply("", String.valueOf(text));
                }
            });
    }

    class Key {
        /** The raw 32-byte public key, base64. Empty when the phone has no fingerprint enrolled. */
        @JavascriptInterface
        public String publicKey() {
            try {
                KeyStore store = store();
                if (!store.containsAlias(KEY_ALIAS)) {
                    KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
                    generator.initialize(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(new ECGenParameterSpec("ed25519"))
                        .setDigests(KeyProperties.DIGEST_NONE)
                        .setUserAuthenticationRequired(true)
                        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                        .setInvalidatedByBiometricEnrollment(true)
                        .build());
                    generator.generateKeyPair();
                }
                byte[] encoded = store.getCertificate(KEY_ALIAS).getPublicKey().getEncoded();
                return Base64.encodeToString(Arrays.copyOfRange(encoded, encoded.length - 32, encoded.length), Base64.NO_WRAP);
            } catch (Exception error) {
                Log.e("Thumbprint", "key", error);
                return "";
            }
        }

        @JavascriptInterface
        public void sign(final String message) {
            runOnUiThread(() -> MainActivity.this.sign(message));
        }

        @JavascriptInterface
        public void openBrowser(String url) {
            if (url.startsWith(ORIGIN + "/")) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
    }
}
