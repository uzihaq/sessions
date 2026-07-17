package state

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
)

func TestLaunchdRunnerProgramArguments(t *testing.T) {
	root := t.TempDir()
	runner := filepath.Join(root, "runner")
	if err := os.WriteFile(runner, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		path string
		want []string
	}{
		{name: "bare relative is refused", path: "runner"},
		{name: "missing absolute is refused", path: filepath.Join(root, "missing")},
		{name: "absolute executable", path: runner, want: []string{runner}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			launcher := NewLaunchdLauncher(Config{RunnerPath: test.path})
			if got := launcher.ProgramArguments(proto.LaunchRequest{}); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("ProgramArguments() = %#v, want %#v", got, test.want)
			}
		})
	}
}
