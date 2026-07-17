package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	backupstore "github.com/uzihaq/pretty-pty/prettygo/internal/backup"
)

func (a *app) cmdBackup(args []string) error {
	if len(args) == 0 {
		return fail(1, "usage: pretty backup <enable|now|status>")
	}
	switch args[0] {
	case "enable":
		return a.cmdBackupEnable(append([]string(nil), args[1:]...))
	case "now":
		if len(args) != 1 {
			return fail(1, "usage: pretty backup now")
		}
		return a.cmdBackupNow()
	case "status":
		if len(args) != 1 {
			return fail(1, "usage: pretty backup status")
		}
		return a.cmdBackupStatus()
	default:
		return fail(1, "unknown backup command: %s", args[0])
	}
}

func (a *app) cmdBackupEnable(args []string) error {
	project, found := pluck(&args, "--project")
	if !found || strings.TrimSpace(project) == "" {
		return fail(1, "usage: pretty backup enable --project <somewhere-project> [--interval 15m]")
	}
	interval := backupstore.DefaultInterval
	if raw, present := pluck(&args, "--interval"); present {
		parsed, err := parseDuration(raw, 0)
		if err != nil {
			return err
		}
		if parsed <= 0 {
			return fail(1, "--interval must be greater than zero")
		}
		interval = parsed
	}
	if len(args) != 0 {
		return fail(1, "usage: pretty backup enable --project <somewhere-project> [--interval 15m]")
	}
	config, err := backupstore.Enable(
		backupstore.ConfigPath(a.home), backupstore.SomewhereConfigPath(a.home), project, interval,
	)
	if err != nil {
		return fail(1, "%s", err)
	}
	// Wake a currently running daemon. Enable remains durable even when the
	// daemon is stopped; the daemon also reloads this config on its next start.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, _ = a.api.request(ctx, http.MethodPost, "/api/backup/reload", nil, 0)
	if a.wantJSON {
		return writeJSON(a.stdout, config.Status(), true)
	}
	_, err = fmt.Fprintf(a.stdout, "Backup enabled for somewhere project %s (every %s).\n", config.Project, config.Interval)
	return err
}

func (a *app) cmdBackupNow() error {
	var result backupstore.Result
	if err := a.postJSON("/api/backup/now", nil, &result, 2); err != nil {
		return err
	}
	if a.wantJSON {
		return writeJSON(a.stdout, result, true)
	}
	_, err := fmt.Fprintf(a.stdout, "Backup pushed: %d uploaded, %d unchanged, %d sessions.\n", result.Uploaded, result.Skipped, result.SessionCount)
	return err
}

func (a *app) cmdBackupStatus() error {
	config, err := backupstore.LoadConfig(backupstore.ConfigPath(a.home))
	if errors.Is(err, os.ErrNotExist) {
		if a.wantJSON {
			return writeJSON(a.stdout, backupstore.Status{}, true)
		}
		_, err = fmt.Fprintln(a.stdout, "Backup is disabled.")
		return err
	}
	if err != nil {
		return fail(1, "%s", err)
	}
	status := config.Status()
	if a.wantJSON {
		return writeJSON(a.stdout, status, true)
	}
	if !status.Enabled {
		_, err = fmt.Fprintln(a.stdout, "Backup is disabled.")
		return err
	}
	lastPush := "never"
	if status.LastPushAt != "" {
		lastPush = status.LastPushAt
	}
	_, err = fmt.Fprintf(a.stdout,
		"Backup enabled: project %s, every %s. Last push: %s (%d uploaded, %d unchanged, %d sessions).\n",
		status.Project, status.Interval, lastPush, status.LastPushCount, status.LastPushSkipped, status.LastSessionCount,
	)
	return err
}
