package waitcond

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestCommitFiresOnRealCommit(t *testing.T) {
	repo := newGitRepo(t)
	condition, err := NewCommit(context.Background(), "commit-session", repo)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		writeFile(t, filepath.Join(repo, "work.txt"), "second\n")
		git(t, repo, "add", "work.txt")
		git(t, repo, "commit", "-m", "real second commit")
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := condition.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Commit == result.Baseline || result.Subject != "real second commit" || result.HistoryRewritten {
		t.Fatalf("unexpected commit result: %#v", result)
	}
	t.Logf("commit wait: baseline=%s commit=%s subject=%q history_rewritten=%v", result.Baseline, result.Commit, result.Subject, result.HistoryRewritten)
}

func TestCommitFlagsForceResetHistoryRewrite(t *testing.T) {
	repo := newGitRepo(t)
	writeFile(t, filepath.Join(repo, "work.txt"), "second\n")
	git(t, repo, "add", "work.txt")
	git(t, repo, "commit", "-m", "second")
	condition, err := NewCommit(context.Background(), "rewrite-session", repo)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		git(t, repo, "reset", "--hard", "HEAD^")
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := condition.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !result.HistoryRewritten || result.Subject != "initial" {
		t.Fatalf("unexpected rewrite result: %#v", result)
	}
	t.Logf("force reset: baseline=%s commit=%s subject=%q history_rewritten=%v", result.Baseline, result.Commit, result.Subject, result.HistoryRewritten)
}

func TestFileContainsAppendAndRecreate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "status.log")
	writeFile(t, path, "starting\n")

	t.Run("append", func(t *testing.T) {
		condition, err := NewFileContains("append-session", root, "status.log", "READY")
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			time.Sleep(100 * time.Millisecond)
			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			if _, err := file.WriteString("READY\n"); err != nil {
				t.Error(err)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		result, err := condition.Wait(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("append observed: session=%s file=%s literal=%q", result.Session, result.File, result.Contains)
	})

	t.Run("delete-and-recreate", func(t *testing.T) {
		writeFile(t, path, "not yet\n")
		condition, err := NewFileContains("recreate-session", root, path, "DONE")
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			time.Sleep(100 * time.Millisecond)
			if err := os.Remove(path); err != nil {
				t.Error(err)
				return
			}
			time.Sleep(50 * time.Millisecond)
			writeFile(t, path, "replacement DONE\n")
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		result, err := condition.Wait(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("recreate observed: session=%s file=%s literal=%q", result.Session, result.File, result.Contains)
	})
}

func TestIdleStableResetsAndReportsEvidenceSource(t *testing.T) {
	root := t.TempDir()
	var working atomic.Bool
	condition, err := NewIdleStable("idle-session", root, 120*time.Millisecond, func(context.Context) (IdleSample, error) {
		return IdleSample{Working: working.Load(), Source: "structured"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	working.Store(false)
	go func() {
		time.Sleep(60 * time.Millisecond)
		working.Store(true)
		time.Sleep(60 * time.Millisecond)
		working.Store(false)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	started := time.Now()
	result, err := condition.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "structured" || time.Since(started) < 220*time.Millisecond {
		t.Fatalf("idle stability did not reset: %#v after %s", result, time.Since(started))
	}
}

func TestWaitAnyReturnsFirstSatisfiedCondition(t *testing.T) {
	root := t.TempDir()
	first, err := NewFileContains("first", root, "first.log", "WIN")
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewFileContains("second", root, "second.log", "WIN")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		writeFile(t, filepath.Join(root, "second.log"), "WIN\n")
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := WaitAny(ctx, []Condition{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if result.Session != "second" {
		t.Fatalf("winner = %q, want second", result.Session)
	}
	t.Logf("--any winner: session=%s condition=%s", result.Session, result.Kind)
}

func newGitRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	git(t, repo, "config", "user.name", "Pretty Wait Test")
	git(t, repo, "config", "user.email", "pretty-wait@example.invalid")
	writeFile(t, filepath.Join(repo, "work.txt"), "initial\n")
	git(t, repo, "add", "work.txt")
	git(t, repo, "commit", "-q", "-m", "initial")
	return repo
}

func git(t *testing.T, repo string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repo}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return string(output)
}

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
