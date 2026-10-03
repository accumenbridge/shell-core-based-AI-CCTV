package com.quadbridge.nativesession;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "NativeSession")
public final class NativeSessionPlugin extends Plugin {
    private static final String KEY_ALIAS = "com.quadbridge.native-session.v1";
    private static final String FILE_NAME = "qb-user-session.enc";
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{20,256}");
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    @PluginMethod
    public synchronized void read(PluginCall call) {
        try {
            byte[] envelope;
            try (FileInputStream input = sessionFile().openRead()) {
                envelope = readBounded(input, 1024);
            } catch (java.io.FileNotFoundException absent) {
                JSObject result = new JSObject();
                result.put("token", JSONObject.NULL);
                call.resolve(result);
                return;
            }
            if (envelope.length <= IV_BYTES + TAG_BITS / 8) throw new IllegalStateException("Invalid secure session envelope");
            byte[] iv = Arrays.copyOfRange(envelope, 0, IV_BYTES);
            byte[] ciphertext = Arrays.copyOfRange(envelope, IV_BYTES, envelope.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            String token = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
            if (!TOKEN.matcher(token).matches()) throw new IllegalStateException("Invalid secure session value");
            JSObject result = new JSObject();
            result.put("token", token);
            call.resolve(result);
        } catch (Exception failure) {
            call.reject("Secure native session could not be read", "INCOMPATIBLE");
        }
    }

    @PluginMethod
    public synchronized void save(PluginCall call) {
        String token = call.getString("token");
        if (token == null || !TOKEN.matcher(token).matches()) {
            call.reject("Invalid native session value", "INVALID");
            return;
        }
        AtomicFile file = sessionFile();
        FileOutputStream output = null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != IV_BYTES) throw new IllegalStateException("Secure session encryption returned an invalid nonce");
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] envelope = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, envelope, 0, iv.length);
            System.arraycopy(encrypted, 0, envelope, iv.length, encrypted.length);
            output = file.startWrite();
            output.write(envelope);
            output.getFD().sync();
            file.finishWrite(output);
            call.resolve();
        } catch (Exception failure) {
            if (output != null) file.failWrite(output);
            call.reject("Secure native session could not be saved", "UNAVAILABLE");
        }
    }

    @PluginMethod
    public synchronized void clear(PluginCall call) {
        try {
            sessionFile().delete();
            call.resolve();
        } catch (Exception failure) {
            call.reject("Secure native session could not be cleared", "UNAVAILABLE");
        }
    }

    private AtomicFile sessionFile() {
        File directory = getContext().getNoBackupFilesDir();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Secure storage unavailable");
        return new AtomicFile(new File(directory, FILE_NAME));
    }

    private static byte[] readBounded(FileInputStream input, int maximum) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] chunk = new byte[256];
        int total = 0, count;
        while ((count = input.read(chunk)) >= 0) {
            total += count;
            if (total > maximum) throw new IllegalStateException("Secure session envelope exceeds its bound");
            output.write(chunk, 0, count);
        }
        return output.toByteArray();
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
