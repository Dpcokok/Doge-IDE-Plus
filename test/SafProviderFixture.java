package com.doge.ide;

import android.webkit.MimeTypeMap;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Simulates opaque SAF IDs, MIME-based naming and real file writes. */
final class SafProviderFixture {
    private static final class Node {
        final String id, parent, name, mime;
        final Path path;
        Node(String id, String parent, String name, String mime, Path path) {
            this.id = id; this.parent = parent; this.name = name; this.mime = mime; this.path = path;
        }
    }
    private final Map<String, Node> nodes = new LinkedHashMap<>();
    int creates;
    boolean nullQuery, wrongName, denyRename;
    String failWrite;

    SafProviderFixture(Path root) throws IOException {
        Files.createDirectories(root);
        nodes.put("root", new Node("root", null, "Project", DocumentsContract.Document.MIME_TYPE_DIR, root));
    }

    Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        if (nullQuery && uri.children) return null;
        List<String[]> rows = new ArrayList<>();
        for (Node node : nodes.values()) {
            if (uri.children ? !uri.id.equals(node.parent) : !uri.id.equals(node.id)) continue;
            String[] row = new String[projection.length];
            for (int i = 0; i < row.length; i++) {
                switch (projection[i]) {
                    case "document_id": row[i] = node.id; break;
                    case "_display_name": row[i] = node.name; break;
                    case "mime_type": row[i] = node.mime; break;
                    default: throw new IllegalArgumentException(projection[i]);
                }
            }
            rows.add(row);
        }
        return new Cursor(rows);
    }

    private String uniqueName(String parent, String name) {
        String candidate = name;
        int dot = name.lastIndexOf('.');
        if (dot <= 0) dot = name.length();
        for (int copy = 1; child(parent, candidate) != null; copy++)
            candidate = name.substring(0, dot) + " (" + copy + ")" + name.substring(dot);
        return candidate;
    }

    Uri create(Uri parent, String mime, String requestedName) throws IOException {
        String name = requestedName;
        if (!mime.equals(DocumentsContract.Document.MIME_TYPE_DIR)) {
            int dot = name.lastIndexOf('.');
            String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
            String extMime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            // Android FileUtils appends .txt for a text/plain request with a different extension MIME.
            if ("text/plain".equals(mime) && !mime.equals(extMime)) name += ".txt";
            if (wrongName) name += ".txt";
        }
        name = uniqueName(parent.id, name);
        String id = "opaque-" + (++creates);
        Path path = nodes.get(parent.id).path.resolve(name);
        if (mime.equals(DocumentsContract.Document.MIME_TYPE_DIR)) Files.createDirectory(path);
        else Files.createFile(path);
        nodes.put(id, new Node(id, parent.id, name, mime, path));
        return new Uri(id, false);
    }

    Uri rename(Uri uri, String name) throws IOException {
        if (denyRename) throw new IOException("fixture rename denied");
        Node old = nodes.get(uri.id);
        String actual = uniqueName(old.parent, name);
        Path target = old.path.resolveSibling(actual);
        Files.move(old.path, target);
        nodes.put(uri.id, new Node(uri.id, old.parent, actual, old.mime, target));
        return uri;
    }

    boolean delete(Uri uri) throws IOException {
        Node old = nodes.remove(uri.id);
        return old != null && Files.deleteIfExists(old.path);
    }
    InputStream openInputStream(Uri uri) throws IOException {
        return Files.newInputStream(nodes.get(uri.id).path);
    }
    OutputStream openOutputStream(Uri uri, String mode) throws IOException {
        if (!"wt".equals(mode)) throw new IOException("Expected truncate mode: " + mode);
        Node node = nodes.get(uri.id);
        if (node.name.equals(failWrite)) throw new IOException("fixture write denied");
        return Files.newOutputStream(node.path, StandardOpenOption.TRUNCATE_EXISTING);
    }
    String child(String parent, String name) {
        for (Node node : nodes.values()) if (parent.equals(node.parent) && name.equals(node.name)) return node.id;
        return null;
    }
    String idForPath(String path) {
        String parent = "root";
        for (String part : path.split("/")) {
            parent = child(parent, part);
            if (parent == null) return null;
        }
        return parent;
    }
    String text(String path) throws IOException { return Files.readString(nodes.get(idForPath(path)).path); }
    long fileCount() { return nodes.values().stream().filter(n -> !DocumentsContract.Document.MIME_TYPE_DIR.equals(n.mime)).count(); }
    List<String> names() { return nodes.values().stream().map(n -> n.name).toList(); }
}

final class Uri {
    final String id;
    final boolean children;
    Uri(String id, boolean children) { this.id = id; this.children = children; }
}

final class Cursor implements AutoCloseable {
    private final List<String[]> rows;
    private int position = -1;
    Cursor(List<String[]> rows) { this.rows = rows; }
    boolean moveToNext() { return ++position < rows.size(); }
    boolean moveToFirst() { position = 0; return !rows.isEmpty(); }
    String getString(int column) { return rows.get(position)[column]; }
    public void close() {}
}

final class OpenableColumns { static final String DISPLAY_NAME = "_display_name"; }

final class DocumentsContract {
    static final class Document {
        static final String COLUMN_DOCUMENT_ID = "document_id", COLUMN_DISPLAY_NAME = "_display_name", COLUMN_MIME_TYPE = "mime_type";
        static final String MIME_TYPE_DIR = "vnd.android.document/directory";
    }
    static Uri buildDocumentUriUsingTree(Uri tree, String id) { return new Uri(id, false); }
    static Uri buildChildDocumentsUriUsingTree(Uri tree, String id) { return new Uri(id, true); }
    static String getDocumentId(Uri uri) { return uri.id; }
    static Uri createDocument(SafProviderFixture r, Uri parent, String mime, String name) throws IOException { return r.create(parent, mime, name); }
    static Uri renameDocument(SafProviderFixture r, Uri uri, String name) throws IOException { return r.rename(uri, name); }
    static boolean deleteDocument(SafProviderFixture r, Uri uri) throws IOException { return r.delete(uri); }
}
