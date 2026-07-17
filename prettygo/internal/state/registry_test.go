package state

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest"
)

func TestDiscoveryAttachesKnownSocketsAndPreservesUnknownOnes(t *testing.T) {
	root := t.TempDir()
	config := Config{
		DefaultShell: "/bin/bash", DefaultCwd: root, DefaultCols: 300, DefaultRows: 50,
		RunnerStateDir: filepath.Join(root, "runners"), LaunchAgentsDir: filepath.Join(root, "agents"),
	}
	launcher := prototest.NewLauncher()
	first := NewRegistry(config, launcher)
	created, err := first.Create(context.Background(), CreateSessionRequest{Cmd: "/bin/sh", Cwd: root, Name: "survives discovery"})
	if err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(config.RunnerStateDir, created.ID+".sock")
	if err := os.WriteFile(socketPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	second := NewRegistry(config, launcher)
	if err := second.Discover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sessions := second.List(false); len(sessions) != 1 || sessions[0].ID != created.ID || sessions[0].Name != "survives discovery" {
		t.Fatalf("discovered sessions = %#v", sessions)
	}
	metadata, err := ReadRunnerMetadata(filepath.Join(config.RunnerStateDir, created.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Name != "survives discovery" {
		t.Fatalf("persisted metadata name = %q", metadata.Name)
	}

	unknownID := "00000000-0000-4000-8000-000000000000"
	unknownSocket := filepath.Join(config.RunnerStateDir, unknownID+".sock")
	unknownMetadata := filepath.Join(config.RunnerStateDir, unknownID+".json")
	if err := os.WriteFile(unknownSocket, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	encoded := `{"id":"` + unknownID + `","cmd":"/bin/sh","args":[],"cwd":"` + root + `","cols":300,"rows":50,"createdAt":1,"pid":999,"sockPath":"` + unknownSocket + `"}`
	if err := os.WriteFile(unknownMetadata, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := second.Discover(context.Background()); err == nil {
		t.Fatal("discovering an unavailable fake runner unexpectedly succeeded")
	}
	for _, path := range []string{unknownSocket, unknownMetadata} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("discovery removed sacred state %s: %v", path, err)
		}
	}
}

func TestCreateRefusesMissingRunnerBeforeWritingState(t *testing.T) {
	root := t.TempDir()
	config := Config{
		DefaultShell: "/bin/bash", DefaultCwd: root, DefaultCols: 300, DefaultRows: 50,
		RunnerStateDir: filepath.Join(root, "runners"), LaunchAgentsDir: filepath.Join(root, "agents"),
	}
	registry := NewRegistry(config, NewLaunchdLauncher(config))
	_, err := registry.Create(context.Background(), CreateSessionRequest{Cmd: "/bin/sh", Cwd: root})
	if err == nil || !strings.Contains(err.Error(), "runner executable unavailable") {
		t.Fatalf("Create() error = %v, want clear runner executable refusal", err)
	}
	for _, path := range []string{config.RunnerStateDir, config.LaunchAgentsDir} {
		if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("failed create mutated %s: %v", path, statErr)
		}
	}
}
