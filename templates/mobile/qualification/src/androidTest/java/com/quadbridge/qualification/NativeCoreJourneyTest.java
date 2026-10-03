package com.quadbridge.qualification;

import android.content.Context;
import android.content.Intent;
import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityService;
import android.webkit.WebView;

import androidx.test.espresso.UiController;
import androidx.test.espresso.ViewAction;
import androidx.test.espresso.web.webdriver.DriverAtoms;
import androidx.test.espresso.web.webdriver.Locator;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.hamcrest.Matcher;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.Key;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.web.assertion.WebViewAssertions.webMatches;
import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.getText;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webKeys;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.is;

/**
 * Real installed WebView journey. Credentials and secure-session observations are read/written
 * only in the target app's private files directory; the test never logs them or accepts them as
 * instrumentation arguments.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeCoreJourneyTest {
    private static final String FIXTURE_FILE = "native-qualification.json";
    private static final int MAX_FIXTURE_BYTES = 32768;
    private static final int MAX_ENCRYPTED_SESSION_BYTES = 1024;
    private static final String KEY_ALIAS = "com.quadbridge.native-session.v1";
    private static final String SESSION_FILE = "qb-user-session.enc";
    private static final String SESSION_OBSERVATION = "window.__qbNativeQualificationSession";

    @Test
    public void completesSelectedNativeStage() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        JSONObject fixture = readFixture(target);
        String stage = InstrumentationRegistry.getArguments().getString("stage", "");
        switch (stage) {
            case "sign-in-and-business": runSignInAndBusiness(target, fixture); break;
            case "restored-session": runRestoredSession(target, fixture); break;
            case "revoked-session": runRevokedSession(target, fixture); break;
            case "logout-relaunch": runLogoutRelaunch(target); break;
            default: throw new AssertionError("A fixed native qualification stage is required");
        }
    }

    private static void runSignInAndBusiness(Context target, JSONObject fixture) throws Exception {
        launchApp(target);
        waitForBody("Sign in", 30000);
        signIn(fixture.getJSONObject("admin"));
        chooseTenant(fixture.getJSONArray("tenantIds").getString(0));

        openWorkspace("/requests");
        waitForBody("Create a request", 30000);
        waitForBody("Reference search", 30000);
        JSONObject request = fixture.getJSONObject("request");
        type("input[name='title']", request.getString("title"));
        type("textarea[name='details']", request.getString("details"));
        clickButton("Create request");
        waitForBody(request.getString("title"), 30000);

        chooseTenant(fixture.getJSONArray("tenantIds").getString(1));
        waitForBody("No requests in this tenant.", 30000);
        assertBodyLacks(request.getString("title"));
        chooseTenant(fixture.getJSONArray("tenantIds").getString(0));
        waitForBody(request.getString("title"), 30000);

        signOut();
        signIn(fixture.getJSONObject("viewer"));
        chooseTenant(fixture.getJSONArray("tenantIds").getString(0));
        waitForBody("Read access only. New requests are not permitted.", 30000);
        waitForBody(request.getString("title"), 30000);
        chooseTenant(fixture.getJSONArray("tenantIds").getString(1));
        waitForBody("No requests in this tenant.", 30000);
        assertBodyLacks(request.getString("title"));
        signOut();
        signIn(fixture.getJSONObject("admin"));
        chooseTenant(fixture.getJSONArray("tenantIds").getString(0));

        openWorkspace("/library");
        waitForBody("Knowledge library", 30000);
        waitForBody("Recent requests", 30000);
        waitForBody(request.getString("title"), 30000);
        JSONObject knowledge = fixture.getJSONObject("knowledge");
        type("textarea[aria-label='Question']", knowledge.getString("question"));
        clickButton("Answer from sources");
        waitForBody(knowledge.getString("modelLabel"), 180000);
        JSONArray documents = knowledge.getJSONArray("documents");
        for (int index = 0; index < documents.length(); index++) {
            JSONObject document = documents.getJSONObject(index);
            waitForBody(document.getString("title"), 30000);
            waitForBody(document.getString("excerpt"), 30000);
        }

        String token = readNativeSessionToken();
        String displayedAnswer = readDisplayedAnswer();
        if (displayedAnswer.length() > 16384 || !displayedAnswer.contains(knowledge.getString("modelLabel")))
            throw new AssertionError("The visible model answer could not be captured within its private result bound");
        for (int index = 0; index < documents.length(); index++)
            if (!displayedAnswer.contains(documents.getJSONObject(index).getString("title")) ||
                    !displayedAnswer.contains(documents.getJSONObject(index).getString("excerpt")))
                throw new AssertionError("A verified source citation is missing from the displayed answer");

        writePrivateResult(target, "native-qualification-pre-background.json",
                new JSONObject().put("stage", "pre-background-observation").put("lifecycleComplete", false)
                        .put("productId", fixture.getString("productId")).put("instanceId", fixture.getString("instanceId"))
                        .put("tenantId", fixture.getJSONArray("tenantIds").getString(0)).put("sessionToken", token)
                        .put("displayedAnswer", displayedAnswer).put("secureStorage", observeSecureStorage(target, token)));
        backgroundAndResume(target);
        assertBodyLacks("Sign in");
        openWorkspace("/requests");
        waitForBody(request.getString("title"), 30000);
        String resumedToken = readNativeSessionToken();
        if (!token.equals(resumedToken)) throw new AssertionError("Background and resume changed the encrypted native session");
        writePrivateResult(target, "native-qualification-sign-in-and-business.json",
                new JSONObject().put("stage", "sign-in-and-business").put("productId", fixture.getString("productId"))
                        .put("instanceId", fixture.getString("instanceId")).put("tenantId", fixture.getJSONArray("tenantIds").getString(0))
                        .put("sessionToken", token).put("displayedAnswer", displayedAnswer)
                        .put("backgroundResume", new JSONObject().put("homeDispatched", true).put("uiRevalidated", true)
                                .put("requestVisibleAfterResume", true).put("sameSession", true))
                        .put("secureStorage", observeSecureStorage(target, token)));
    }

    private static void runRestoredSession(Context target, JSONObject fixture) throws Exception {
        launchApp(target);
        waitForBody("Service requests", 30000);
        assertBodyLacks("Sign in");
        openWorkspace("/requests");
        waitForBody("Create a request", 30000);
        waitForBody(fixture.getJSONObject("request").getString("title"), 30000);
        clickButton("Account");
        waitForBody(fixture.getJSONObject("admin").getString("username"), 10000);
        waitForBody(fixture.getString("instanceId"), 10000);
        String token = readNativeSessionToken();
        JSONObject first = readPrivateResult(target, "native-qualification-sign-in-and-business.json");
        if (!token.equals(first.optString("sessionToken"))) throw new AssertionError("The encrypted native session did not survive cold relaunch");
        writePrivateResult(target, "native-qualification-restored-session.json",
                new JSONObject().put("stage", "restored-session").put("authenticated", true).put("sameSession", true)
                        .put("secureStorage", observeSecureStorage(target, token)));
    }

    private static void runRevokedSession(Context target, JSONObject fixture) throws Exception {
        launchApp(target);
        waitForBody("Sign in", 30000);
        assertBodyLacks("Service requests");
        if (readNativeSessionToken() != null) throw new AssertionError("A revoked native session remained in secure storage");
        signIn(fixture.getJSONObject("admin"));
        chooseTenant(fixture.getJSONArray("tenantIds").getString(0));
        waitForBody("Service requests", 30000);
        String token = readNativeSessionToken();
        writePrivateResult(target, "native-qualification-revoked-session.json",
                new JSONObject().put("stage", "revoked-session").put("productId", fixture.getString("productId"))
                        .put("instanceId", fixture.getString("instanceId")).put("sessionToken", token));
        signOut();
        waitForBody("Sign in", 30000);
        if (readNativeSessionToken() != null) throw new AssertionError("UI logout did not clear the secure native session");
    }

    private static void runLogoutRelaunch(Context target) throws Exception {
        launchApp(target);
        waitForBody("Sign in", 30000);
        assertBodyLacks("Service requests");
        if (readNativeSessionToken() != null) throw new AssertionError("The logged-out session returned after cold relaunch");
        writePrivateResult(target, "native-qualification-logout-relaunch.json",
                new JSONObject().put("stage", "logout-relaunch").put("signedOut", true).put("secureStoreEmpty", true));
    }

    private static JSONObject readFixture(Context target) throws Exception {
        byte[] bytes;
        try (FileInputStream input = target.openFileInput(FIXTURE_FILE); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[1024];
            int total = 0, count;
            while ((count = input.read(chunk)) >= 0) {
                total += count;
                if (total > MAX_FIXTURE_BYTES) throw new AssertionError("Private qualification fixture exceeds its bound");
                output.write(chunk, 0, count);
            }
            bytes = output.toByteArray();
        }
        JSONObject value = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        if (!"qb.native-qualification.v1".equals(value.optString("schema")) ||
                !value.optString("productId").matches("[a-z][a-z0-9-]{1,47}") ||
                !value.optString("productVersion").matches("[0-9]+\\.[0-9]+\\.[0-9]+") ||
                !value.optString("instanceId").matches("[a-z][a-z0-9-]{1,47}"))
            throw new AssertionError("Private qualification fixture identity is invalid");
        JSONArray tenants = value.optJSONArray("tenantIds");
        if (tenants == null || tenants.length() != 2 || !tenants.getString(0).matches("[a-z][a-z0-9-]{0,47}") ||
                !tenants.getString(1).matches("[a-z][a-z0-9-]{0,47}") || tenants.getString(0).equals(tenants.getString(1)))
            throw new AssertionError("Private qualification tenant fixture is invalid");
        validateCredential(value.optJSONObject("admin"));
        validateCredential(value.optJSONObject("viewer"));
        JSONObject request = value.optJSONObject("request"), knowledge = value.optJSONObject("knowledge");
        JSONArray documents = knowledge == null ? null : knowledge.optJSONArray("documents");
        if (request == null || bounded(request.optString("title"), 200).isEmpty() || bounded(request.optString("details"), 64000).isEmpty() ||
                knowledge == null || bounded(knowledge.optString("question"), 1000).isEmpty() || bounded(knowledge.optString("modelLabel"), 256).isEmpty() ||
                documents == null || documents.length() < 1 || documents.length() > 8)
            throw new AssertionError("Private qualification fixture inputs are invalid");
        for (int index = 0; index < documents.length(); index++) {
            JSONObject document = documents.getJSONObject(index);
            if (bounded(document.optString("id"), 128).isEmpty() || bounded(document.optString("title"), 256).isEmpty() ||
                    document.optInt("version", 0) < 1 || bounded(document.optString("excerpt"), 512).isEmpty())
                throw new AssertionError("Private qualification evidence fixture is invalid");
        }
        return value;
    }

    private static void validateCredential(JSONObject credential) {
        if (credential == null || bounded(credential.optString("username"), 128).isEmpty() ||
                bounded(credential.optString("password"), 256).length() < 12)
            throw new AssertionError("Private qualification credentials are invalid");
    }

    private static String bounded(String value, int maximum) {
        return value != null && !value.trim().isEmpty() && value.length() <= maximum ? value : "";
    }

    private static Intent launchIntent(Context target) {
        Intent launch = target.getPackageManager().getLaunchIntentForPackage(target.getPackageName());
        if (launch == null) throw new AssertionError("Generated app has no launch activity");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return launch;
    }

    private static void launchApp(Context target) {
        InstrumentationRegistry.getInstrumentation().startActivitySync(launchIntent(target));
    }

    private static void signIn(JSONObject credential) throws Exception {
        waitForBody("Sign in", 30000);
        type("input[name='username']", credential.getString("username"));
        type("input[name='password']", credential.getString("password"));
        clickButton("Sign in");
        waitForBody("Service requests", 30000);
    }

    private static void signOut() {
        clickButton("Account");
        clickButton("Sign out");
        waitForBody("Sign in", 30000);
    }

    private static void chooseTenant(String tenantId) {
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "select[aria-label='Tenant'] option[value='" + tenantId + "']"))
                .perform(webClick());
    }

    private static void openWorkspace(String path) {
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "nav.mobile-bottom-nav a[data-workspace-path='" + path + "']"))
                .perform(webClick());
    }

    private static void backgroundAndResume(Context target) throws Exception {
        UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        if (!automation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME))
            throw new AssertionError("Android did not dispatch the real Home lifecycle transition");
        android.os.SystemClock.sleep(750);
        target.startActivity(launchIntent(target));
        waitForBody("Service requests", 30000);
    }

    private static void type(String selector, String value) {
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webKeys(value));
    }

    private static void clickButton(String label) {
        onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(.)='" + label + "']"))
                .perform(webClick());
    }

    private static void clickText(String text) {
        onWebView().withElement(findElement(Locator.XPATH, "//*[normalize-space(.)='" + text + "']"))
                .perform(webClick());
    }

    private static void waitForBody(String text, long timeoutMs) {
        long deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs;
        AssertionError last = null;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            try {
                onWebView().withElement(findElement(Locator.TAG_NAME, "body"))
                        .check(webMatches(getText(), containsString(text)));
                return;
            } catch (AssertionError failure) {
                last = failure;
                android.os.SystemClock.sleep(200);
            }
        }
        throw new AssertionError("Expected native UI state did not appear");
    }

    private static void assertBodyLacks(String text) {
        onWebView().withElement(findElement(Locator.TAG_NAME, "body"))
                .check(webMatches(getText(), org.hamcrest.Matchers.not(containsString(text))));
    }

    private static String readNativeSessionToken() throws Exception {
        evaluate("(async()=>{const plugin=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.NativeSession;if(!plugin)throw new Error('Native session bridge unavailable');" +
                SESSION_OBSERVATION + "=await plugin.read();return true})()");
        long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            String value = evaluate("(" + SESSION_OBSERVATION + "&&" + SESSION_OBSERVATION + ".token)||null");
            if (value != null) {
                if (!value.matches("[A-Za-z0-9_-]{20,256}")) throw new AssertionError("Secure native session bridge returned an invalid token");
                evaluate("delete " + SESSION_OBSERVATION);
                return value;
            }
            // The null result is meaningful only after the actual plugin promise has settled.
            String ready = evaluate("typeof " + SESSION_OBSERVATION + "==='object'&&" + SESSION_OBSERVATION + "!==null?'ready':'pending'");
            if ("ready".equals(ready)) {
                evaluate("delete " + SESSION_OBSERVATION);
                return null;
            }
            android.os.SystemClock.sleep(50);
        }
        throw new AssertionError("Secure native session bridge did not settle");
    }

    private static JSONObject observeSecureStorage(Context target, String token) throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) throw new AssertionError("The native session encryption key is missing");
        Key key = keyStore.getKey(KEY_ALIAS, null);
        if (key == null || !"AES".equals(key.getAlgorithm()) || key.getEncoded() != null)
            throw new AssertionError("The native session key is not a non-exportable AES key");

        File encryptedFile = new File(target.getNoBackupFilesDir(), SESSION_FILE);
        if (!encryptedFile.isFile() || encryptedFile.length() < 28 || encryptedFile.length() > MAX_ENCRYPTED_SESSION_BYTES)
            throw new AssertionError("The encrypted session file is missing or outside its bound");
        byte[] ciphertext;
        try (FileInputStream input = new FileInputStream(encryptedFile); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[256];
            int total = 0, count;
            while ((count = input.read(chunk)) >= 0) {
                total += count;
                if (total > MAX_ENCRYPTED_SESSION_BYTES) throw new AssertionError("The encrypted session file exceeds its bound");
                output.write(chunk, 0, count);
            }
            ciphertext = output.toByteArray();
        }
        byte[] plaintext = token.getBytes(StandardCharsets.UTF_8);
        if (containsSequence(ciphertext, plaintext)) throw new AssertionError("The secure session file contains plaintext token bytes");
        String digest = toHex(MessageDigest.getInstance("SHA-256").digest(ciphertext));
        return new JSONObject().put("androidKeyStoreAliasPresent", true).put("keyAlgorithm", "AES")
                .put("keyNonExportable", true).put("noBackupCiphertextPresent", true)
                .put("noBackupCiphertextBytes", ciphertext.length).put("plaintextTokenAbsent", true)
                .put("noBackupCiphertextSha256", digest);
    }

    private static boolean containsSequence(byte[] value, byte[] sequence) {
        if (sequence.length == 0 || sequence.length > value.length) return false;
        for (int offset = 0; offset <= value.length - sequence.length; offset++) {
            int index = 0;
            while (index < sequence.length && value[offset + index] == sequence[index]) index++;
            if (index == sequence.length) return true;
        }
        return false;
    }

    private static String toHex(byte[] value) {
        StringBuilder output = new StringBuilder(value.length * 2);
        for (byte item : value) output.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return output.toString();
    }

    private static String evaluate(String source) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> raw = new AtomicReference<>();
        onView(isAssignableFrom(WebView.class)).perform(new ViewAction() {
            @Override public Matcher<android.view.View> getConstraints() { return isAssignableFrom(WebView.class); }
            @Override public String getDescription() { return "evaluate a fixed native qualification observation in the actual WebView"; }
            @Override public void perform(UiController controller, android.view.View view) {
                ((WebView) view).evaluateJavascript(source, value -> { raw.set(value); latch.countDown(); });
            }
        });
        if (!latch.await(10, TimeUnit.SECONDS) || raw.get() == null) throw new AssertionError("Native WebView observation did not complete");
        Object value = new JSONTokener(raw.get()).nextValue();
        return value == JSONObject.NULL ? null : String.valueOf(value);
    }

    private static String readDisplayedAnswer() throws Exception {
        String text = evaluate("(()=>{const question=document.querySelector(\"textarea[aria-label='Question']\");return question&&question.parentElement&&question.parentElement.nextElementSibling?question.parentElement.nextElementSibling.innerText:''})()");
        return text == null ? "" : text;
    }

    private static JSONObject readPrivateResult(Context target, String name) throws Exception {
        try (FileInputStream input = target.openFileInput(name); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[512];
            int count;
            while ((count = input.read(chunk)) >= 0) output.write(chunk, 0, count);
            return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    private static void writePrivateResult(Context target, String name, JSONObject result) throws Exception {
        byte[] bytes = (result.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = target.openFileOutput(name, Context.MODE_PRIVATE)) {
            output.write(bytes);
            output.getFD().sync();
        }
    }
}
