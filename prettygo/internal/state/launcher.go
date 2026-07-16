package state

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
)

// LaunchdLauncher boots the plist already written by Registry and then
// attaches through the canonical runner socket protocol.
type LaunchdLauncher struct {
	config Config
}

func NewLaunchdLauncher(config Config) *LaunchdLauncher {
	return &LaunchdLauncher{config: config}
}

func (l *LaunchdLauncher) ProgramArguments(proto.LaunchRequest) []string {
	if !filepath.IsAbs(l.config.RunnerPath) && !strings.ContainsRune(l.config.RunnerPath, filepath.Separator) {
		return []string{"/usr/bin/env", l.config.RunnerPath}
	}
	return []string{l.config.RunnerPath}
}

func (l *LaunchdLauncher) Launch(ctx context.Context, request proto.LaunchRequest) (proto.Runner, error) {
	plist := plistPath(l.config.LaunchAgentsDir, request.Info.ID)
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	command := exec.Command("launchctl", "bootstrap", domain, plist)
	output, err := command.CombinedOutput()
	if err != nil {
		var exitError *exec.ExitError
		alreadyLoaded := errors.As(err, &exitError) && exitError.ExitCode() == 17
		alreadyLoaded = alreadyLoaded || strings.Contains(strings.ToLower(string(output)), "already loaded") ||
			strings.Contains(strings.ToLower(string(output)), "already bootstrapped")
		if !alreadyLoaded {
			return nil, fmt.Errorf("launchctl bootstrap %s: %w: %s", request.Info.ID, err, strings.TrimSpace(string(output)))
		}
	}
	return l.waitAndAttach(ctx, request.Info)
}

func (l *LaunchdLauncher) Attach(ctx context.Context, info proto.RunnerInfo) (proto.Runner, error) {
	if info.SocketPath == "" {
		info.SocketPath = filepath.Join(l.config.RunnerStateDir, info.ID+".sock")
	}
	return proto.DialRunner(ctx, info.SocketPath)
}

func (l *LaunchdLauncher) waitAndAttach(ctx context.Context, info proto.RunnerInfo) (proto.Runner, error) {
	deadline := time.Now().Add(60 * time.Second)
	var lastErr error
	for {
		runner, err := l.Attach(ctx, info)
		if err == nil {
			return runner, nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("runner did not create socket within 60s: %s: %w", info.SocketPath, lastErr)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(30 * time.Millisecond):
		}
	}
}

// Reap unloads a cleanly exited runner so launchd cannot retain a stale
// service registration after its plist is removed.
func (l *LaunchdLauncher) Reap(id string) error {
	domain := fmt.Sprintf("gui/%d/tech.pretty-pty.runner.%s", os.Getuid(), id)
	output, err := exec.Command("launchctl", "bootout", domain).CombinedOutput()
	if removeErr := os.Remove(plistPath(l.config.LaunchAgentsDir, id)); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) && err == nil {
		err = removeErr
	}
	if err != nil {
		return fmt.Errorf("launchctl bootout %s: %w: %s", id, err, strings.TrimSpace(string(output)))
	}
	return nil
}
