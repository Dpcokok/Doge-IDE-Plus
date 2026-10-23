package com.doge.ide;

import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import java.util.ArrayDeque;
import org.json.JSONArray;
import org.json.JSONObject;

/** WebView's real IME boundary; records only event metadata, never editor text. */
final class EditorWebView extends WebView {
    private final ArrayDeque<JSONObject> inputEvents = new ArrayDeque<>();
    private final ArrayDeque<JSONObject> inputTransitions = new ArrayDeque<>();
    private JSONObject lastDeletion;
    private JSONArray deletionFollowing;
    private int deletionFollowingCount;
    private int connectionId;

    EditorWebView(Context context) { super(context); }

    private synchronized void record(String event, int connection, int a, int b, boolean result) {
        try {
            JSONObject item = new JSONObject().put("uptime", SystemClock.uptimeMillis()).put("time", System.currentTimeMillis())
                    .put("event", event).put("connection", connection).put("a", a).put("b", b)
                    .put("result", result).put("focused", hasFocus()).put("windowFocused", hasWindowFocus());
            switch (event) {
                case "commit-text":
                case "compose-text":
                    item.put("length", a).put("newCursorPosition", b);
                    break;
                case "compose-region":
                case "set-selection":
                case "create-connection":
                    item.put("start", a).put("end", b);
                    break;
                case "delete-surrounding":
                case "delete-codepoints":
                    item.put("beforeLength", a).put("afterLength", b);
                    break;
                case "hardware-key":
                case "ime-key":
                    item.put("keyCode", a).put("action", b);
                    break;
                default:
                    break;
            }
            if (deletionFollowing != null && deletionFollowingCount < 40) {
                deletionFollowing.put(item);
                deletionFollowingCount++;
            }
            // Sogou deletes a selection with commitText("") before sending DEL.
            // Preserve the onset separately so further typing cannot overwrite it.
            if (("commit-text".equals(event) && a == 0) || "delete-surrounding".equals(event)
                    || "delete-codepoints".equals(event)
                    || ("ime-key".equals(event) && a == KeyEvent.KEYCODE_DEL && b == KeyEvent.ACTION_DOWN)) {
                JSONArray before = new JSONArray();
                for (JSONObject previous : inputEvents) before.put(previous);
                deletionFollowing = new JSONArray();
                deletionFollowingCount = 0;
                lastDeletion = new JSONObject().put("trigger", item).put("before", before).put("after", deletionFollowing);
            }
            inputEvents.addLast(item);
            while (inputEvents.size() > 100) inputEvents.removeFirst();
            if (event.startsWith("sync-") || "restart-input".equals(event)
                    || "create-connection".equals(event) || "close-connection".equals(event)
                    || "compose-region".equals(event) || "finish-compose".equals(event)
                    || "set-selection".equals(event) || "delete-surrounding".equals(event)
                    || "delete-codepoints".equals(event) || ("commit-text".equals(event) && a == 0)) {
                inputTransitions.addLast(item);
                while (inputTransitions.size() > 80) inputTransitions.removeFirst();
            }
        } catch (Exception ignored) { /* diagnostics must not alter input delivery */ }
    }

    private static int diagnosticKey(KeyEvent event) {
        int code = event.getKeyCode();
        // Printable key codes identify characters; retain only deletion/navigation/modifier codes.
        return code == KeyEvent.KEYCODE_DEL || code == KeyEvent.KEYCODE_FORWARD_DEL
                || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_TAB
                || code == KeyEvent.KEYCODE_BACK || KeyEvent.isModifierKey(code)
                || (code >= KeyEvent.KEYCODE_DPAD_UP && code <= KeyEvent.KEYCODE_DPAD_CENTER) ? code : -1;
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        boolean result = super.dispatchKeyEvent(event);
        record("hardware-key", connectionId, diagnosticKey(event), event.getAction(), result);
        return result;
    }

    @Override public InputConnection onCreateInputConnection(EditorInfo info) {
        InputConnection target = super.onCreateInputConnection(info);
        final int id = ++connectionId;
        record("create-connection", id, info.initialSelStart, info.initialSelEnd, target != null);
        if (target == null) return null;
        return new InputConnectionWrapper(target, false) {
            private int batchDepth;
            @Override public boolean commitText(CharSequence text, int cursor) {
                boolean result = super.commitText(text, cursor);
                record("commit-text", id, text == null ? 0 : text.length(), cursor, result);
                return result;
            }
            @Override public boolean setComposingText(CharSequence text, int cursor) {
                boolean result = super.setComposingText(text, cursor);
                record("compose-text", id, text == null ? 0 : text.length(), cursor, result);
                return result;
            }
            @Override public boolean setComposingRegion(int start, int end) {
                boolean result = super.setComposingRegion(start, end);
                record("compose-region", id, start, end, result);
                return result;
            }
            @Override public boolean finishComposingText() {
                boolean result = super.finishComposingText();
                record("finish-compose", id, batchDepth, 0, result);
                return result;
            }
            @Override public boolean deleteSurroundingText(int before, int after) {
                boolean result = super.deleteSurroundingText(before, after);
                record("delete-surrounding", id, before, after, result);
                return result;
            }
            @Override public boolean deleteSurroundingTextInCodePoints(int before, int after) {
                boolean result = super.deleteSurroundingTextInCodePoints(before, after);
                record("delete-codepoints", id, before, after, result);
                return result;
            }
            @Override public boolean setSelection(int start, int end) {
                boolean result = super.setSelection(start, end);
                record("set-selection", id, start, end, result);
                return result;
            }
            @Override public boolean sendKeyEvent(KeyEvent event) {
                boolean result = super.sendKeyEvent(event);
                record("ime-key", id, diagnosticKey(event), event.getAction(), result);
                return result;
            }
            @Override public boolean beginBatchEdit() {
                boolean result = super.beginBatchEdit();
                if (result) batchDepth++;
                record("begin-batch", id, batchDepth, 0, result);
                return result;
            }
            @Override public boolean endBatchEdit() {
                boolean result = super.endBatchEdit();
                batchDepth = Math.max(0, batchDepth - 1);
                record("end-batch", id, batchDepth, 0, result);
                return result;
            }
            @Override public void closeConnection() {
                record("close-connection", id, batchDepth, 0, true);
                super.closeConnection();
            }
        };
    }

    // Called on the UI thread only, after JavaScript confirms its document/input is still current.
    boolean restartEditorInput() {
        InputMethodManager manager = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        boolean ready = manager != null && hasFocus() && hasWindowFocus();
        record("restart-input", connectionId, 0, 0, ready);
        if (ready) manager.restartInput(this);
        return ready;
    }

    void noteEditorInputSync(String event, int requestId, boolean accepted) {
        record(event, connectionId, requestId, 0, accepted);
    }

    synchronized String inputDiagnostics() {
        try {
            JSONArray events = new JSONArray();
            for (JSONObject event : inputEvents) events.put(event);
            JSONArray transitions = new JSONArray();
            for (JSONObject event : inputTransitions) transitions.put(event);
            String ime = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD);
            return new JSONObject().put("schemaVersion", 2).put("capturedAt", System.currentTimeMillis()).put("uptime", SystemClock.uptimeMillis())
                    .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
                    .put("ime", ime).put("transitions", transitions).put("lastDeletion", lastDeletion)
                    .put("events", events).toString();
        } catch (Exception ignored) { return "{\"unavailable\":true}"; }
    }
}
