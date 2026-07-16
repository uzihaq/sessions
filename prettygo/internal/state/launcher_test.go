package state

import (
	"path/filepath"
	"reflect"
	"testing"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
)

func TestLaunchdRunnerProgramArguments(t *testing.T) {
	tests := []struct {
		name string
		path string
		want []string
	}{
		{name: "path lookup", path: "runner", want: []string{"/usr/bin/env", "runner"}},
		{name: "absolute", path: filepath.Join(string(filepath.Separator), "opt", "pretty", "runner"), want: []string{filepath.Join(string(filepath.Separator), "opt", "pretty", "runner")}},
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
