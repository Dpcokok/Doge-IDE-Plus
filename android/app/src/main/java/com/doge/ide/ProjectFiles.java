package com.doge.ide;

import android.webkit.MimeTypeMap;
import java.util.Locale;

/** Project metadata recognition and document creation MIME policy. */
final class ProjectFiles {
    private ProjectFiles() {}

    static boolean isInternalManifestPath(String path) {
        if (path == null) return false;
        String normalized = path.replace('\\', '/');
        if (!normalized.matches("[A-Za-z0-9._/-]+") || normalized.startsWith("/") || normalized.contains("..")) return false;
        return ".doge-project.json".equalsIgnoreCase(normalized.substring(normalized.lastIndexOf('/') + 1));
    }

    static String mimeTypeForPath(String path) {
        String name = path == null ? "" : path.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        int dot = name.lastIndexOf('.');
        if (dot <= slash + 1 || dot == name.length() - 1) return "text/plain";

        String extension = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        // SAF providers may append .txt when text/plain disagrees with this mapping.
        String mimeType = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        if (mimeType != null) return mimeType;

        switch (extension) {
            case "py": return "text/x-python";
            case "c": return "text/x-csrc";
            case "h": return "text/x-chdr";
            case "cc": case "cpp": case "cxx": return "text/x-c++src";
            case "hh": case "hpp": case "hxx": return "text/x-c++hdr";
            case "json": return "application/json";
            case "csv": return "text/csv";
            case "md": return "text/markdown";
            default: return "text/plain";
        }
    }
}
