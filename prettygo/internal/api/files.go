package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

const maxUploadBody = 25 * 1024 * 1024

var unsafeUploadName = regexp.MustCompile(`[^A-Za-z0-9_.\- ]`)

type directoryCandidate struct {
	Path  string `json:"path"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

type directoryEntry struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Hidden bool   `json:"hidden"`
}

func listDirectoryCandidates() []directoryCandidate {
	home, err := os.UserHomeDir()
	if err != nil {
		return []directoryCandidate{}
	}
	common := []string{"Desktop", "Documents", "Downloads", "Code", "code", "projects", "Projects", "dev", "src", "work"}
	seen := make(map[string]bool)
	out := make([]directoryCandidate, 0, 50)
	push := func(path, kind string) {
		if seen[path] {
			return
		}
		if _, err := os.Stat(path); err != nil {
			return
		}
		seen[path] = true
		label := path
		if path == home {
			label = "~"
		} else if strings.HasPrefix(path, home+string(filepath.Separator)) {
			label = "~" + strings.TrimPrefix(path, home)
		}
		out = append(out, directoryCandidate{Path: path, Label: label, Kind: kind})
	}

	push(home, "home")
	for _, name := range common {
		push(filepath.Join(home, name), "common")
	}
	for _, path := range listProjectChildren(home, 20) {
		push(path, "project")
	}
	initial := append([]directoryCandidate(nil), out...)
	for _, candidate := range initial {
		if candidate.Kind != "common" {
			continue
		}
		for _, path := range listProjectChildren(candidate.Path, 15) {
			push(path, "project")
		}
		if len(out) >= 50 {
			break
		}
	}
	return out
}

func listProjectChildren(parent string, maximum int) []string {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return []string{}
	}
	projects := make([]string, 0, maximum)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		path := filepath.Join(parent, entry.Name())
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() || !isProjectDirectory(path) {
			continue
		}
		projects = append(projects, path)
		if len(projects) >= maximum {
			break
		}
	}
	sort.Strings(projects)
	return projects
}

func isProjectDirectory(path string) bool {
	for _, marker := range []string{".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

func (s *Server) handleFSList(response http.ResponseWriter, request *http.Request, corsOrigin string) {
	home, err := os.UserHomeDir()
	if err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return
	}
	path := ""
	if values, present := request.URL.Query()["path"]; present && len(values) > 0 {
		path = values[0]
	} else {
		path = home
	}
	if !filepath.IsAbs(path) {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": "path must be absolute"}, corsOrigin)
		return
	}
	canonical := canonicalPath(path)
	canonicalHome := canonicalPath(home)
	if canonical != canonicalHome && !strings.HasPrefix(canonical, canonicalHome+string(filepath.Separator)) {
		s.sendJSON(response, http.StatusForbidden, map[string]any{
			"error": "path outside home directory", "path": canonical,
		}, corsOrigin)
		return
	}

	info, err := os.Stat(canonical)
	if err != nil {
		s.sendFilesystemError(response, err, corsOrigin)
		return
	}
	if !info.IsDir() {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{
			"error": "not a directory", "path": canonical,
		}, corsOrigin)
		return
	}
	children, err := os.ReadDir(canonical)
	if err != nil {
		s.sendFilesystemError(response, err, corsOrigin)
		return
	}
	entries := make([]directoryEntry, 0, len(children))
	for _, child := range children {
		kind := "other"
		full := filepath.Join(canonical, child.Name())
		linkInfo, err := os.Lstat(full)
		if err == nil {
			switch {
			case linkInfo.Mode()&os.ModeSymlink != 0:
				target, targetErr := os.Stat(full)
				switch {
				case targetErr != nil:
					kind = "symlink"
				case target.IsDir():
					kind = "dir"
				case target.Mode().IsRegular():
					kind = "file"
				}
			case linkInfo.IsDir():
				kind = "dir"
			case linkInfo.Mode().IsRegular():
				kind = "file"
			}
		}
		entries = append(entries, directoryEntry{
			Name: child.Name(), Kind: kind, Hidden: strings.HasPrefix(child.Name(), "."),
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		iDir := entries[i].Kind == "dir"
		jDir := entries[j].Kind == "dir"
		if iDir != jDir {
			return iDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	var parent any
	if canonical != canonicalHome {
		parent = filepath.Dir(canonical)
	}
	s.sendJSON(response, http.StatusOK, map[string]any{
		"path": canonical, "parent": parent, "entries": entries,
	}, corsOrigin)
}

func canonicalPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	if absolute, err := filepath.Abs(path); err == nil {
		return filepath.Clean(absolute)
	}
	return filepath.Clean(path)
}

func (s *Server) sendFilesystemError(response http.ResponseWriter, err error, corsOrigin string) {
	status := http.StatusInternalServerError
	code := filesystemErrorCode(err)
	switch code {
	case "ENOENT":
		status = http.StatusNotFound
	case "EACCES":
		status = http.StatusForbidden
	}
	body := map[string]any{"error": err.Error()}
	if code != "" {
		body["code"] = code
	}
	s.sendJSON(response, status, body, corsOrigin)
}

func filesystemErrorCode(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case syscall.EACCES:
		return "EACCES"
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EPERM:
		return "EPERM"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.ELOOP:
		return "ELOOP"
	case syscall.ENAMETOOLONG:
		return "ENAMETOOLONG"
	case syscall.EIO:
		return "EIO"
	case syscall.EMFILE:
		return "EMFILE"
	case syscall.ENFILE:
		return "ENFILE"
	default:
		return ""
	}
}

func (s *Server) handleUpload(response http.ResponseWriter, request *http.Request, corsOrigin string) {
	filename := request.Header.Get("X-Pretty-Filename")
	if filename == "" {
		filename = "file"
	}
	safeBase := unsafeUploadName.ReplaceAllString(nodeBaseName(filename), "_")
	if len(safeBase) > 96 {
		safeBase = safeBase[:96]
	}
	extension := nodeExtension(safeBase)
	stem := strings.TrimSuffix(safeBase, extension)
	if stem == "" {
		stem = "file"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return
	}
	uploadsDir := filepath.Join(home, ".local", "state", "pretty-PTY", "uploads")
	if err := os.MkdirAll(uploadsDir, 0o700); err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return
	}

	body, err := io.ReadAll(io.LimitReader(request.Body, maxUploadBody+1))
	if err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return
	}
	if len(body) > maxUploadBody {
		_, _ = io.Copy(io.Discard, request.Body)
		s.sendJSON(response, http.StatusRequestEntityTooLarge, map[string]any{
			"error": "file too large", "max": maxUploadBody,
		}, corsOrigin)
		return
	}
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return
	}
	outName := stem + "-" + hex.EncodeToString(random) + extension
	outPath := filepath.Join(uploadsDir, outName)
	if err := os.WriteFile(outPath, body, 0o600); err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return
	}
	s.sendJSON(response, http.StatusOK, map[string]any{"path": outPath, "size": len(body)}, corsOrigin)
}

func nodeBaseName(path string) string {
	path = strings.TrimRight(path, string(filepath.Separator))
	if path == "" {
		return ""
	}
	if index := strings.LastIndexByte(path, byte(filepath.Separator)); index >= 0 {
		return path[index+1:]
	}
	return path
}

func nodeExtension(base string) string {
	if base == "." || base == ".." {
		return ""
	}
	index := strings.LastIndexByte(base, '.')
	if index <= 0 {
		return ""
	}
	return base[index:]
}
