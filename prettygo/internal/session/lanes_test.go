package session

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

func TestSimilarLaneDeathsCoalesceAtThirdNotification(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	launcher := prototest.NewLauncher()
	notifications := make(chan PushPayload, 3)
	manager := NewManager(config, launcher, ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
		Notify: func(payload PushPayload) { notifications <- payload },
	})
	defer manager.Close()

	ids := make([]string, 0, 3)
	for index := range 3 {
		created, err := manager.Create(context.Background(), state.CreateSessionRequest{
			Cmd: "/bin/sh", Args: []string{"-c", "exit 7"}, Cwd: root,
			Name: "failure", Kind: state.KindLane,
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, created.ID)
		if err := state.WriteCompletionManifest(filepath.Join(config.RunnerStateDir, created.ID+".manifest.json"), state.CompletionManifest{
			ExitCode: 7, DurationMS: int64(index + 1), LastOutputTail: "same failure\n",
		}); err != nil {
			t.Fatal(err)
		}
	}
	code := 7
	for _, id := range ids {
		launcher.Runner(id).Emit(proto.Event{Kind: proto.EventExit, Exit: proto.ExitEvent{Code: &code}})
	}

	titles := make(map[string]int)
	for range 3 {
		select {
		case payload := <-notifications:
			titles[payload.Title]++
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for coalesced notifications")
		}
	}
	if titles["3 lanes died"] != 1 || titles["🔴 failure died (exit 7)"] != 2 {
		t.Fatalf("notification titles = %#v", titles)
	}
}
