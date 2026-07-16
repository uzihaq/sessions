package watch

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestResolveClaudeJSONL(t *testing.T) {
	const launchID = "aaaaaaaa-1111-2222-3333-444444444444"
	const otherID = "bbbbbbbb-5555-6666-7777-888888888888"

	tests := []struct {
		name       string
		files      []string
		launchUUID string
		missingDir bool
		wantFile   string
		wantReason ClaudeResolveReason
	}{
		{
			name:       "exact wins alongside another conversation",
			files:      []string{otherID + ".jsonl", launchID + ".jsonl"},
			launchUUID: launchID,
			wantFile:   launchID + ".jsonl",
			wantReason: ClaudeExact,
		},
		{
			name:       "missing launch id with sole file",
			files:      []string{otherID + ".jsonl"},
			launchUUID: launchID,
			wantFile:   otherID + ".jsonl",
			wantReason: ClaudeSoleFile,
		},
		{
			name:       "ambiguous is deliberately unresolved",
			files:      []string{otherID + ".jsonl", "cccccccc.jsonl"},
			launchUUID: launchID,
			wantReason: ClaudeAmbiguous,
		},
		{
			name:       "empty directory",
			launchUUID: launchID,
			wantReason: ClaudeEmptyDir,
		},
		{
			name:       "missing directory",
			launchUUID: launchID,
			missingDir: true,
			wantReason: ClaudeNoDir,
		},
		{
			name:       "no launch id with sole file",
			files:      []string{otherID + ".jsonl"},
			wantFile:   otherID + ".jsonl",
			wantReason: ClaudeSoleFile,
		},
		{
			name:       "no launch id with multiple files",
			files:      []string{otherID + ".jsonl", launchID + ".jsonl"},
			wantReason: ClaudeAmbiguous,
		},
		{
			name:       "non-jsonl files ignored",
			files:      []string{otherID + ".jsonl", "notes.txt", launchID + ".jsonl.tmp"},
			launchUUID: launchID,
			wantFile:   otherID + ".jsonl",
			wantReason: ClaudeSoleFile,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "project")
			if !test.missingDir {
				if err := os.Mkdir(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				for _, name := range test.files {
					if err := os.WriteFile(filepath.Join(dir, name), []byte("{}\n"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}

			got := ResolveClaudeJSONL(dir, test.launchUUID)
			if got.Reason != test.wantReason {
				t.Fatalf("reason = %q, want %q", got.Reason, test.wantReason)
			}
			wantPath := ""
			if test.wantFile != "" {
				wantPath = filepath.Join(dir, test.wantFile)
			}
			if got.Path != wantPath {
				t.Fatalf("path = %q, want %q", got.Path, wantPath)
			}
		})
	}
}

func TestClaudeResolverHelpers(t *testing.T) {
	if got, want := EncodeClaudeCWD("/Users/uzair/Projects/rail-me"), "-Users-uzair-Projects-rail-me"; got != want {
		t.Fatalf("EncodeClaudeCWD() = %q, want %q", got, want)
	}
	dir := t.TempDir()
	for _, name := range []string{"one.jsonl", "two.jsonl", "notes.txt", "three.jsonl.tmp"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got := ListClaudeJSONLFiles(dir)
	sort.Strings(got)
	if want := []string{"one.jsonl", "two.jsonl"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ListClaudeJSONLFiles() = %v, want %v", got, want)
	}
}
