package org.pyras.thumbprint;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.LayerDrawable;
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
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.net.HttpURLConnection;
import java.net.URL;
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
// A second tab holds x.com with the same marks the browser extension draws. That page never gets
// the key: it can only ask the phone page to approve a draft, which shows the fingerprint prompt.
public class MainActivity extends Activity {
    static final String ORIGIN = "https://thumbprint.pyras.org";
    static final String KEY_ALIAS = "approval";
    static final int ACCENT = 0xFF14F195, MUTED = 0xFF8A8C85, BORDER = 0xFF2A2C28;
    WebView web;
    WebView x;
    TextView homeTab, xTab;

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
        x = new WebView(this);
        x.setBackgroundColor(Color.BLACK);
        x.getSettings().setJavaScriptEnabled(true);
        x.getSettings().setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(x, true);
        x.addJavascriptInterface(new Host(), "ThumbprintHost");
        final String marks = marks();
        // ponytail: no file chooser or fullscreen video here, so attaching media needs the X app.
        // Add a WebChromeClient when that matters.
        x.setWebViewClient(new WebViewClient() {
            // Only X itself loads next to the bridge; every other link leaves for the browser.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String host = String.valueOf(request.getUrl().getHost());
                boolean onX = host.equals("x.com") || host.endsWith(".x.com") || host.equals("twitter.com") || host.endsWith(".twitter.com");
                if (!request.isForMainFrame() || ("https".equals(request.getUrl().getScheme()) && onX)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(marks, null);
            }
        });

        LinearLayout tabs = new LinearLayout(this);
        homeTab = tab("Thumbprint", false);
        xTab = tab("X", true);
        tabs.addView(homeTab, new LinearLayout.LayoutParams(0, dp(46), 1));
        tabs.addView(xTab, new LinearLayout.LayoutParams(0, dp(46), 1));
        FrameLayout pages = new FrameLayout(this);
        pages.addView(web);
        pages.addView(x);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);
        root.addView(tabs);
        root.addView(pages, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        show(false);
        open(getIntent());
    }

    int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    TextView tab(String label, final boolean forX) {
        TextView tab = new TextView(this);
        tab.setText(label.toUpperCase());
        tab.setGravity(Gravity.CENTER);
        tab.setTextSize(12);
        tab.setLetterSpacing(0.12f);
        tab.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tab.setOnClickListener(view -> show(forX));
        return tab;
    }

    void show(boolean showX) {
        if (showX && x.getUrl() == null) x.loadUrl("https://x.com/home");
        x.setVisibility(showX ? View.VISIBLE : View.GONE);
        web.setVisibility(showX ? View.GONE : View.VISIBLE);
        style(xTab, showX);
        style(homeTab, !showX);
    }

    void style(TextView tab, boolean active) {
        tab.setTextColor(active ? ACCENT : MUTED);
        LayerDrawable underline = new LayerDrawable(new Drawable[] { new ColorDrawable(active ? ACCENT : BORDER), new ColorDrawable(Color.BLACK) });
        underline.setLayerInset(1, 0, 0, 0, dp(active ? 2 : 1));
        tab.setBackground(underline);
    }

    @Override
    public void onBackPressed() {
        if (x.getVisibility() != View.VISIBLE) super.onBackPressed();
        else if (x.canGoBack()) x.goBack();
        else show(false);
    }

    // The extension's stylesheet and content script, as built into the app by build.sh.
    String marks() {
        try {
            String style = new String(getAssets().open("content.css").readAllBytes(), StandardCharsets.UTF_8);
            String script = new String(getAssets().open("inject.js").readAllBytes(), StandardCharsets.UTF_8);
            return "if(!window.thumbprintLoaded){window.thumbprintLoaded=true;const sheet=new CSSStyleSheet();sheet.replaceSync(" + JSONObject.quote(style)
                + ");document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];" + script + "}";
        } catch (Exception error) {
            Log.e("Thumbprint", "marks", error);
            return "";
        }
    }

    String post(String path, String body) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + path).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            connection.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            return new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return "null";
        }
    }

    void answer(final String id, final String result) {
        runOnUiThread(() -> x.evaluateJavascript("thumbprintReply(" + JSONObject.quote(id) + "," + JSONObject.quote(result) + ")", null));
    }

    // All that x.com can reach. A lookup goes to our server; an approval goes to the phone page,
    // which builds the message itself and shows it on the fingerprint prompt.
    class Host {
        @JavascriptInterface
        public void send(final String id, String type, final String body) {
            if (type.equals("lookup")) new Thread(() -> answer(id, post("/v1/lookup", body))).start();
            else if (type.equals("approve")) runOnUiThread(() -> web.evaluateJavascript("approveForX(" + JSONObject.quote(id) + "," + JSONObject.quote(body) + ")", null));
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) {
            show(false);
            open(intent);
        }
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

        /** The phone page's answer to an approval X asked for. */
        @JavascriptInterface
        public void xResult(String id, String result) {
            answer(id, result);
        }

        @JavascriptInterface
        public void openBrowser(String url) {
            if (url.startsWith(ORIGIN + "/")) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
    }
}
