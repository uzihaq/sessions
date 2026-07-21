package session

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/uzihaq/sessions/runtime/internal/ledger"
	"github.com/uzihaq/sessions/runtime/internal/proto/prototest"
	"github.com/uzihaq/sessions/runtime/internal/state"
)

func TestCreateProvenanceGraphValidationAndDeadParentClassification(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	store, err := ledger.Open(context.Background(), ledger.Options{Path: filepath.Join(root, "ledger", "lanes.sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	launcher := prototest.NewLauncher()
	manager := NewManager(config, launcher, ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
		Boundaries: store.Boundaries(), Observations: store.Observations(), LedgerReader: store,
	})
	t.Cleanup(manager.Close)

	parent, err := manager.Create(context.Background(), state.CreateSessionRequest{Cmd: "/bin/sh", Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	wantUser := "uid:" + strconv.Itoa(os.Getuid())
	if parent.CreatorKind != string(ledger.CreatorUser) || parent.CreatorID != wantUser ||
		parent.RootCreatorKind != string(ledger.CreatorUser) || parent.RootCreatorID != wantUser {
		t.Fatalf("user fallback provenance = %#v", parent)
	}

	child, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, Kind: state.KindLane, CreatorSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	grandchild, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, Kind: state.KindLane, CreatorSessionID: child.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentSessionID != parent.ID || !reflect.DeepEqual(child.CreatorAncestry, []string{parent.ID}) {
		t.Fatalf("direct child provenance = %#v", child)
	}
	if grandchild.ParentSessionID != child.ID ||
		!reflect.DeepEqual(grandchild.CreatorAncestry, []string{child.ID, parent.ID}) ||
		grandchild.RootCreatorKind != string(ledger.CreatorUser) || grandchild.RootCreatorID != wantUser {
		t.Fatalf("nested provenance = %#v", grandchild)
	}

	external, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, Kind: state.KindLane, CreatorOwnerID: "board:mine",
	})
	if err != nil {
		t.Fatal(err)
	}
	if external.CreatorKind != string(ledger.CreatorExternal) || external.CreatorID != "board:mine" ||
		external.RootCreatorKind != string(ledger.CreatorExternal) || external.RootCreatorID != "board:mine" {
		t.Fatalf("external provenance = %#v", external)
	}

	invalid := []struct {
		name string
		id   string
		want string
	}{
		{name: "forged", id: "not-a-uuid", want: "invalid creator session UUID"},
		{name: "stale", id: "00000000-0000-4000-8000-000000000099", want: "has no created event"},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			_, createErr := manager.Create(context.Background(), state.CreateSessionRequest{
				Cmd: "/bin/sh", Cwd: root, Kind: state.KindLane, CreatorSessionID: test.id,
			})
			if createErr == nil || !strings.Contains(createErr.Error(), test.want) {
				t.Fatalf("Create() err=%v, want %q", createErr, test.want)
			}
		})
	}
	if _, createErr := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, CreatorSessionID: parent.ID, CreatorOwnerID: "both",
	}); createErr == nil || !strings.Contains(createErr.Error(), "cannot both be set") {
		t.Fatalf("combined creator provenance err=%v", createErr)
	}

	if err := store.Observations().RecordRunnerExited(context.Background(), ledger.RunnerExit{
		Meta: ledger.Meta{LaneID: parent.ID},
	}); err != nil {
		t.Fatal(err)
	}
	listed := manager.List(true)
	byID := make(map[string]state.SessionInfo, len(listed))
	for _, info := range listed {
		byID[info.ID] = info
	}
	if got := byID[child.ID].ProvenanceStatus; got != "parent-dead" {
		t.Fatalf("child provenance status = %q, want parent-dead", got)
	}
	if got := byID[grandchild.ID].ProvenanceStatus; got != "parent-dead" {
		t.Fatalf("grandchild provenance status = %q, want parent-dead", got)
	}
}

func TestListIncludeExitedSynthesizesDurableClosedRecords(t *testing.T) {
	root := t.TempDir()
	store, err := ledger.Open(context.Background(), ledger.Options{Path: filepath.Join(root, "ledger", "lanes.sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	manager := NewManager(testConfig(root), prototest.NewLauncher(), ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
		Boundaries: store.Boundaries(), Observations: store.Observations(), LedgerReader: store,
	})
	t.Cleanup(manager.Close)

	userID := "uid:" + strconv.Itoa(os.Getuid())
	exitedID := "10000000-0000-4000-8000-000000000001"
	tombstonedID := "10000000-0000-4000-8000-000000000002"
	for _, created := range []ledger.Created{
		{Meta: ledger.Meta{LaneID: exitedID, AtMS: 100}, Name: "durable exit", Tool: string(state.ToolLane), Cwd: root, LaneUUID: exitedID, CreatorKind: ledger.CreatorUser, CreatorID: userID},
		{Meta: ledger.Meta{LaneID: tombstonedID, AtMS: 200}, Name: "durable tombstone", Tool: string(state.ToolLane), Cwd: root, LaneUUID: tombstonedID, CreatorKind: ledger.CreatorUser, CreatorID: userID},
	} {
		if err := store.Boundaries().RecordCreated(context.Background(), created); err != nil {
			t.Fatal(err)
		}
	}
	code := 7
	signal := "TERM"
	if err := store.Observations().RecordRunnerExited(context.Background(), ledger.RunnerExit{
		Meta: ledger.Meta{LaneID: exitedID, AtMS: 300}, Code: &code, Signal: &signal,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Boundaries().RecordUserKill(context.Background(), ledger.UserKill{
		Meta: ledger.Meta{LaneID: tombstonedID, AtMS: 400},
	}); err != nil {
		t.Fatal(err)
	}

	if active := manager.List(false); len(active) != 0 {
		t.Fatalf("active list = %+v, want no durable closed records", active)
	}
	listed := manager.List(true)
	if len(listed) != 2 {
		t.Fatalf("include exited list = %+v, want two durable records", listed)
	}
	byID := make(map[string]state.SessionInfo, len(listed))
	for _, info := range listed {
		byID[info.ID] = info
	}
	exited := byID[exitedID]
	if exited.Kind != state.KindLane || !exited.Exited || exited.ExitCode == nil || *exited.ExitCode != code ||
		exited.ExitSignal == nil || *exited.ExitSignal != signal || exited.RootCreatorID != userID {
		t.Fatalf("durable exited record = %+v", exited)
	}
	tombstoned := byID[tombstonedID]
	if tombstoned.Kind != state.KindLane || !tombstoned.Exited || tombstoned.ExitCode != nil || tombstoned.RootCreatorID != userID {
		t.Fatalf("durable tombstoned record = %+v", tombstoned)
	}
}
