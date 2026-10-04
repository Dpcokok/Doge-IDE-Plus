# JVM behavioral tests use real child-process pipes. They do not require a device.
# Android Context, the WASM runner and dependency resolution are isolated fixtures;
# org.json is adapted through Gson bundled with the local Gradle distribution.
param([string]$Case = 'all')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$javac = (Get-Command javac -ErrorAction Stop).Source
$java = Join-Path (Split-Path $javac) 'java.exe'
$gson = Get-ChildItem -Path (Join-Path $repoRoot 'android/.gradle-dist/gradle-*/lib/gson-*.jar') | Select-Object -First 1 -ExpandProperty FullName
if (-not $gson) { throw 'Gson was not found in the local Gradle distribution.' }
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw 'The Windows .NET Framework C# compiler is required for the child-process fixture.' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$work = Join-Path $tempRoot ('doge-runtime-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $sources = @{}
    $sources['Context.java'] = @'
package android.content;
import java.io.File;
public class Context {
    private final File root;
    public Context(File root) { this.root = root; }
    public Context getApplicationContext() { return this; }
    public File getFilesDir() { return root; }
}
'@
    $sources['Build.java'] = @'
package android.os;
public final class Build { public static final class VERSION { public static int SDK_INT = 35; } }
'@
    $sources['Process.java'] = @'
package android.os;
public final class Process {
    public static void killProcess(int pid) { java.lang.ProcessHandle.of(pid).ifPresent(java.lang.ProcessHandle::destroyForcibly); }
}
'@
    $sources['DependencyManager.java'] = @'
package com.doge.ide;
import java.io.File;
import android.content.Context;
final class DependencyManager {
    private final File root;
    private DependencyManager(Context context) { root = new File(context.getFilesDir(), "packages"); }
    static DependencyManager get(Context context) { return new DependencyManager(context); }
    File resolvePackage(String name, String version) {
        File found = new File(root, name + "-" + version);
        return found.isDirectory() ? found : null;
    }
}
'@
    $sources['NativeWasmRunner.java'] = @'
package com.doge.ide;
final class NativeWasmRunner {
    static void cancel() {}
    static String run(byte[] wasm, byte[] input, int timeout) {
        return "{\"status\":\"success\",\"stdout\":\"\",\"stderr\":\"\",\"exit_code\":0}";
    }
}
'@
    $sources['JSONObject.java'] = @'
package org.json;
import com.google.gson.*;
import java.util.*;
public class JSONObject {
    final JsonObject value;
    public JSONObject() { value = new JsonObject(); }
    public JSONObject(String json) { value = JsonParser.parseString(json).getAsJsonObject(); }
    JSONObject(JsonObject value) { this.value = value; }
    static JsonElement wrap(Object x) {
        if (x instanceof JSONObject) return ((JSONObject) x).value;
        if (x instanceof JSONArray) return ((JSONArray) x).value;
        return new Gson().toJsonTree(x);
    }
    public JSONObject put(String key, Object x) { value.add(key, wrap(x)); return this; }
    public Object opt(String key) {
        JsonElement x = value.get(key);
        if (x == null || x.isJsonNull()) return null;
        if (x.isJsonObject()) return new JSONObject(x.getAsJsonObject());
        if (x.isJsonArray()) return new JSONArray(x.getAsJsonArray());
        return new Gson().fromJson(x, Object.class);
    }
    public boolean has(String key) { return value.has(key); }
    public String optString(String key) { return optString(key, ""); }
    public String optString(String key, String fallback) {
        JsonElement x = value.get(key);
        return x == null || x.isJsonNull() ? fallback : x.isJsonPrimitive() ? x.getAsString() : x.toString();
    }
    public int optInt(String key, int fallback) { try { return value.get(key).getAsInt(); } catch (Exception e) { return fallback; } }
    public boolean optBoolean(String key, boolean fallback) { try { return value.get(key).getAsBoolean(); } catch (Exception e) { return fallback; } }
    public JSONObject optJSONObject(String key) { JsonElement x = value.get(key); return x != null && x.isJsonObject() ? new JSONObject(x.getAsJsonObject()) : null; }
    public JSONArray optJSONArray(String key) { JsonElement x = value.get(key); return x != null && x.isJsonArray() ? new JSONArray(x.getAsJsonArray()) : null; }
    public Object get(String key) { return value.get(key); }
    public Iterator<String> keys() { return value.keySet().iterator(); }
    public String toString() { return value.toString(); }
    public String toString(int indent) { return new GsonBuilder().setPrettyPrinting().create().toJson(value); }
    public static String quote(String x) { return new Gson().toJson(x); }
}
'@
    $sources['JSONArray.java'] = @'
package org.json;
import com.google.gson.*;
import java.util.*;
public class JSONArray {
    final JsonArray value;
    public JSONArray() { value = new JsonArray(); }
    public JSONArray(String json) { value = JsonParser.parseString(json).getAsJsonArray(); }
    public JSONArray(Collection<?> items) { this(); for (Object x : items) put(x); }
    JSONArray(JsonArray value) { this.value = value; }
    public JSONArray put(Object x) { value.add(JSONObject.wrap(x)); return this; }
    public int length() { return value.size(); }
    public JSONObject optJSONObject(int i) { try { return new JSONObject(value.get(i).getAsJsonObject()); } catch (Exception e) { return null; } }
    public String optString(int i) { return optString(i, ""); }
    public String optString(int i, String fallback) { try { JsonElement x = value.get(i); return x.isJsonPrimitive() ? x.getAsString() : x.toString(); } catch (Exception e) { return fallback; } }
    public Object remove(int i) { return value.remove(i); }
    public String toString() { return value.toString(); }
    public String toString(int indent) { return new GsonBuilder().setPrettyPrinting().create().toJson(value); }
}
'@
    foreach ($entry in $sources.GetEnumerator()) {
        [IO.File]::WriteAllText((Join-Path $work $entry.Key), $entry.Value, [Text.UTF8Encoding]::new($false))
    }
    & $csc /nologo /target:exe "/out:$work/RuntimeChild.exe" (Join-Path $PSScriptRoot 'fixtures/RuntimeChild.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Child-process fixture compilation failed.' }
    $sourcePaths = @(Get-ChildItem -LiteralPath $work -Filter '*.java' | ForEach-Object FullName)
    $sourcePaths += Join-Path $PSScriptRoot 'RuntimeRegression.java'
    foreach ($name in 'LocalCompiler.java', 'PythonRunner.java', 'TaskRegistry.java', 'ClangdService.java', 'RuntimeCompat.java') {
        $sourcePaths += Join-Path $repoRoot "android/app/src/main/java/com/doge/ide/$name"
    }
    & $javac -encoding UTF-8 --release 17 -classpath $gson -d (Join-Path $work 'classes') @sourcePaths
    if ($LASTEXITCODE -ne 0) { throw 'Runtime test compilation failed.' }
    & $java -cp "$work/classes;$gson" com.doge.ide.RuntimeRegression $work $Case
    if ($LASTEXITCODE -ne 0) { throw 'Runtime regression failed.' }
} finally {
    $resolved = [IO.Path]::GetFullPath($work)
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notmatch '^doge-runtime-test-[a-f0-9]{32}$') {
        throw 'Refusing to remove a path outside the runtime test temporary directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
