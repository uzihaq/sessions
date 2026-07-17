package watch

import (
	"os"
	"path/filepath"
	"strings"
)

// ClaudeResolveReason is the exact TypeScript resolver reason string.
type ClaudeResolveReason string

const (
	ClaudeExact     ClaudeResolveReason = "exact"
	ClaudeSoleFile  ClaudeResolveReason = "sole-file"
	ClaudeAmbiguous ClaudeResolveReason = "ambiguous"
	ClaudeEmptyDir  ClaudeResolveReason = "empty-dir"
	ClaudeNoDir     ClaudeResolveReason = "no-dir"
)

// ClaudeResolution identifies the JSONL to follow. An empty Path for an
// ambiguous directory is intentional: following the wrong conversation is
// worse than showing no structured events.
type ClaudeResolution struct {
	Path   string              `json:"path"`
	Reason ClaudeResolveReason `json:"reason"`
}

// EncodeClaudeCWD matches Claude Code's project-directory convention.
func EncodeClaudeCWD(cwd string) string {
	return strings.ReplaceAll(cwd, "/", "-")
}

// ClaudeProjectsDir returns Claude Code's per-user project-session root.
// Resolve it at call time so tests and scratch daemons can use a fixture HOME.
func ClaudeProjectsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

// ClaudeProjectDir returns Claude's default project directory for cwd. The
// home directory is resolved only when this function is called.
func ClaudeProjectDir(cwd string) (string, error) {
	projects, err := ClaudeProjectsDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(projects, EncodeClaudeCWD(cwd)), nil
}

// ListClaudeJSONLFiles returns JSONL basenames in dir. Missing and unreadable
// directories produce an empty list, matching the TypeScript helper.
func ListClaudeJSONLFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".jsonl") {
			files = append(files, entry.Name())
		}
	}
	return files
}

// ResolveClaudeJSONL applies the normative exact/sole/ambiguous policy.
func ResolveClaudeJSONL(dir, launchUUID string) ClaudeResolution {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ClaudeResolution{Reason: ClaudeNoDir}
	}

	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".jsonl") {
			files = append(files, entry.Name())
		}
	}

	if launchUUID != "" {
		exact := launchUUID + ".jsonl"
		for _, name := range files {
			if name == exact {
				return ClaudeResolution{Path: filepath.Join(dir, exact), Reason: ClaudeExact}
			}
		}
	}

	switch len(files) {
	case 0:
		return ClaudeResolution{Reason: ClaudeEmptyDir}
	case 1:
		return ClaudeResolution{Path: filepath.Join(dir, files[0]), Reason: ClaudeSoleFile}
	default:
		return ClaudeResolution{Reason: ClaudeAmbiguous}
	}
}

// ResolveJSONLPath is a compatibility name matching the TypeScript resolver.
func ResolveJSONLPath(dir, launchUUID string) ClaudeResolution {
	return ResolveClaudeJSONL(dir, launchUUID)
}
