package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigFromEnvParityAndScratchIsolation(t *testing.T) {
	root := t.TempDir()
	runners := filepath.Join(root, "state", "runners")
	web := filepath.Join(root, "web")
	t.Setenv("HOME", root)
	t.Setenv("PRETTYD_HOST", "100.64.1.2")
	t.Setenv("PRETTYD_PORT", "9911")
	t.Setenv("PRETTYD_STATE_DIR", runners)
	t.Setenv("PRETTYD_WEB_DIR", web)
	t.Setenv("SHELL", "/bin/zsh")
	config, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.Host != "100.64.1.2" || config.Port != 9911 || config.DefaultShell != "/bin/zsh" {
		t.Fatalf("unexpected env config: %#v", config)
	}
	if config.RunnerStateDir != runners || config.StateRoot != filepath.Dir(runners) {
		t.Fatalf("unexpected state paths: root=%s runners=%s", config.StateRoot, config.RunnerStateDir)
	}
	for _, path := range []string{config.TokenPath, config.OpenPath, config.LaunchAgentsDir, config.WebDir} {
		if path == "" || !filepath.IsAbs(path) {
			t.Errorf("path is not absolute: %q", path)
		}
	}
	if _, err := os.Stat(runners); !os.IsNotExist(err) {
		t.Fatalf("loading config mutated the state dir: %v", err)
	}
}
