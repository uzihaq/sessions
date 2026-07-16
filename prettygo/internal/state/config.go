package state

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
)

const (
	DefaultHost = "127.0.0.1"
	DefaultPort = 8787
	DefaultCols = 300
	DefaultRows = 50
)

type Config struct {
	Host         string
	Port         int
	DefaultShell string
	DefaultCwd   string
	DefaultCols  int
	DefaultRows  int
	StateRoot    string
	// UserStateRoot is always ~/.local/state/pretty-PTY. Unlike the runner
	// directory, idle and push state do not follow PRETTYD_STATE_DIR.
	UserStateRoot   string
	RunnerStateDir  string
	TokenPath       string
	OpenPath        string
	LaunchAgentsDir string
	GlobalHooksPath string
	WebDir          string
	RunnerPath      string
}

func ConfigFromEnv() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("resolve home directory: %w", err)
	}

	host := getenv("PRETTYD_HOST", DefaultHost)
	port := DefaultPort
	if raw := os.Getenv("PRETTYD_PORT"); raw != "" {
		port, err = strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("invalid PRETTYD_PORT %q", raw)
		}
	}

	stateRoot := filepath.Join(home, ".local", "state", "pretty-PTY")
	userStateRoot := stateRoot
	runnerDir := filepath.Join(stateRoot, "runners")
	if configured := os.Getenv("PRETTYD_STATE_DIR"); configured != "" {
		runnerDir, err = filepath.Abs(configured)
		if err != nil {
			return Config{}, fmt.Errorf("resolve PRETTYD_STATE_DIR: %w", err)
		}
		// PRETTYD_STATE_DIR is the TypeScript sessions.ts runner directory.
		// Keep token/open next to it when it is explicitly overridden so a
		// scratch daemon never consults the user's real state directory.
		if filepath.Base(runnerDir) == "runners" {
			stateRoot = filepath.Dir(runnerDir)
		} else {
			stateRoot = runnerDir
		}
	}

	webDir, err := resolveWebDir(os.Getenv("PRETTYD_WEB_DIR"))
	if err != nil {
		return Config{}, err
	}

	return Config{
		Host:            host,
		Port:            port,
		DefaultShell:    getenv("SHELL", "/bin/bash"),
		DefaultCwd:      getenv("HOME", home),
		DefaultCols:     DefaultCols,
		DefaultRows:     DefaultRows,
		StateRoot:       stateRoot,
		UserStateRoot:   userStateRoot,
		RunnerStateDir:  runnerDir,
		TokenPath:       filepath.Join(stateRoot, "token"),
		OpenPath:        filepath.Join(stateRoot, "open"),
		LaunchAgentsDir: filepath.Join(home, "Library", "LaunchAgents"),
		GlobalHooksPath: filepath.Join(home, ".config", "pretty", "hooks.json"),
		WebDir:          webDir,
		RunnerPath:      resolveRunnerPath(os.Getenv("PRETTYD_RUNNER")),
	}, nil
}

func (c Config) ListenAddress() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func resolveWebDir(explicit string) (string, error) {
	if explicit != "" {
		resolved, err := filepath.Abs(explicit)
		if err != nil {
			return "", fmt.Errorf("resolve PRETTYD_WEB_DIR: %w", err)
		}
		return resolved, nil
	}

	// Match http.ts: prefer the checkout's frontend/dist when present,
	// otherwise fall back to a web directory bundled beside the binary.
	candidates := make([]string, 0, 4)
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "frontend", "dist"),
			filepath.Join(cwd, "..", "frontend", "dist"),
		)
	}
	if executable, err := os.Executable(); err == nil {
		dir := filepath.Dir(executable)
		candidates = append(candidates,
			filepath.Join(dir, "..", "frontend", "dist"),
			filepath.Join(dir, "web"),
		)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return filepath.Abs(candidate)
		}
	}
	if executable, err := os.Executable(); err == nil {
		return filepath.Abs(filepath.Join(filepath.Dir(executable), "web"))
	}
	return filepath.Abs(filepath.Join("web"))
}

func resolveRunnerPath(explicit string) string {
	if explicit != "" {
		if resolved, err := filepath.Abs(explicit); err == nil {
			return resolved
		}
		return explicit
	}
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), "runner")
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate
		}
	}
	return "runner"
}
