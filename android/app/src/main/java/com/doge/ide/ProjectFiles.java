package com.doge.ide;

/** Separates app-owned project metadata from user source and data files. */
final class ProjectFiles {
    private ProjectFiles() {}

    static boolean isInternalManifestPath(String path) {
        if (path == null) return false;
        String normalized = path.replace('\\', '/');
        if (!normalized.matches("[A-Za-z0-9._/-]+") || normalized.startsWith("/") || normalized.contains("..")) return false;
        return ".doge-project.json".equalsIgnoreCase(normalized.substring(normalized.lastIndexOf('/') + 1));
    }
}
