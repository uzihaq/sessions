// Package state owns the runner state-directory layout and persistent event
// framing shared with the TypeScript implementation.
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Paths is the complete on-disk file group for one runner.
type Paths struct {
	Dir    string
	ID     string
	Socket string
	Meta   string
	Events string
	Log    string
}

func For(dir, id string) Paths {
	base := filepath.Join(dir, id)
	return Paths{
		Dir:    dir,
		ID:     id,
		Socket: base + ".sock",
		Meta:   base + ".json",
		Events: base + ".events",
		Log:    base + ".log",
	}
}

// DefaultRunnerDir implements ~/.local/state/pretty-PTY/runners without
// writing it. RUNNER_STATE_DIR remains the launch-time override.
func DefaultRunnerDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, ".local", "state", "pretty-PTY", "runners"), nil
}

func EnsureDir(dir string) error {
	return os.MkdirAll(dir, 0o700)
}

// Metadata mirrors prettyd/src/runner.ts SessionMeta. Field order is kept the
// same so the human-readable JSON also matches the normative implementation.
type Metadata struct {
	ID        string   `json:"id"`
	Cmd       string   `json:"cmd"`
	Args      []string `json:"args"`
	Cwd       string   `json:"cwd"`
	Cols      int      `json:"cols"`
	Rows      int      `json:"rows"`
	CreatedAt int64    `json:"createdAt"`
	PID       int      `json:"pid"`
	SockPath  string   `json:"sockPath"`
}

func WriteMetadata(path string, meta Metadata) error {
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
