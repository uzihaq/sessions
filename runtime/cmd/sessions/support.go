package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"strings"
	"time"
)

const (
	supportTicketURL   = "https://github.com/Somewhere-Tech/sessions/issues/new/choose"
	supportFeedbackURL = "https://github.com/Somewhere-Tech/sessions/issues/new?template=feedback.yml"
	supportBugURL      = "https://github.com/Somewhere-Tech/sessions/issues/new?template=bug_report.yml"
	supportSecurityURL = "https://github.com/Somewhere-Tech/sessions/security/advisories/new"
)

type supportDaemonPreview struct {
	Reachable      bool   `json:"reachable"`
	OK             bool   `json:"ok"`
	Version        string `json:"version,omitempty"`
	Discovering    bool   `json:"discovering,omitempty"`
	SessionsLoaded int    `json:"sessions_loaded,omitempty"`
}

type supportDiagnostics struct {
	GeneratedAt string               `json:"generated_at"`
	CLIVersion  string               `json:"cli_version"`
	OS          string               `json:"os"`
	Arch        string               `json:"arch"`
	Daemon      supportDaemonPreview `json:"daemon"`
}

type supportAgentContract struct {
	MachineReadableCommand string   `json:"machine_readable_command"`
	UserApprovalRequired   bool     `json:"user_approval_required"`
	AutomaticSubmission    bool     `json:"automatic_submission"`
	Capture                []string `json:"capture"`
}

type supportPreview struct {
	SchemaVersion int                  `json:"schema_version"`
	TicketURL     string               `json:"ticket_url"`
	FeedbackURL   string               `json:"feedback_url"`
	BugURL        string               `json:"bug_url"`
	SecurityURL   string               `json:"security_url"`
	Agent         supportAgentContract `json:"agent"`
	Diagnostics   *supportDiagnostics  `json:"diagnostics,omitempty"`
	Excluded      []string             `json:"excluded"`
	Uploaded      bool                 `json:"uploaded"`
}

func (a *app) cmdSupport(args []string) error {
	diagnostics := removeFirst(&args, "--diagnostics")
	if len(args) != 0 {
		return fail(1, "usage: sessions support [--diagnostics]")
	}

	preview := supportPreview{
		SchemaVersion: 1,
		TicketURL:     supportTicketURL,
		FeedbackURL:   supportFeedbackURL,
		BugURL:        supportBugURL,
		SecurityURL:   supportSecurityURL,
		Agent: supportAgentContract{
			MachineReadableCommand: "sessions --json support --diagnostics",
			UserApprovalRequired:   true,
			AutomaticSubmission:    false,
			Capture: []string{
				"the sanitized failing Sessions command shape or app action",
				"the exit code and exact error after removing private data",
				"expected behavior and actual behavior",
				"whether a safe reproduction is repeatable",
			},
		},
		Excluded: []string{
			"transcripts and terminal output",
			"prompts, responses, titles, tags, and session command content",
			"session IDs, process IDs, usernames, hostnames, and filesystem paths",
			"tokens, credentials, environment variables, and provider configuration",
			"logs and crash files",
		},
		Uploaded: false,
	}
	if diagnostics {
		preview.Diagnostics = a.supportDiagnostics()
	}
	if a.wantJSON {
		return writeJSON(a.stdout, preview, true)
	}
	return writeSupportPreview(a.stdout, preview)
}

func (a *app) supportDiagnostics() *supportDiagnostics {
	diagnostics := &supportDiagnostics{
		GeneratedAt: a.now().UTC().Format(time.RFC3339),
		CLIVersion:  version,
		OS:          runtime.GOOS,
		Arch:        runtime.GOARCH,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	response, err := a.api.request(ctx, "GET", "/api/health", nil, 0)
	if err != nil || response.status >= 400 {
		return diagnostics
	}
	var health struct {
		OK             bool   `json:"ok"`
		Version        string `json:"version"`
		Discovering    bool   `json:"discovering"`
		SessionsLoaded int    `json:"sessionsLoaded"`
	}
	if json.Unmarshal(response.body, &health) != nil {
		return diagnostics
	}
	diagnostics.Daemon = supportDaemonPreview{
		Reachable:      true,
		OK:             health.OK,
		Version:        health.Version,
		Discovering:    health.Discovering,
		SessionsLoaded: health.SessionsLoaded,
	}
	return diagnostics
}

func writeSupportPreview(writer io.Writer, preview supportPreview) error {
	if _, err := fmt.Fprintf(
		writer,
		"Sessions support\n\nLeave feedback: %s\nReport a problem: %s\nChoose a ticket type: %s\nPrivate security report: %s\n",
		preview.FeedbackURL,
		preview.BugURL,
		preview.TicketURL,
		preview.SecurityURL,
	); err != nil {
		return err
	}
	if preview.Diagnostics == nil {
		_, err := fmt.Fprintf(
			writer,
			"\nAgents: run `%s`, describe the sanitized failing command shape, exit code, expected behavior, and sanitized error, then ask the user before opening or submitting a ticket.\n\nRun `sessions support --diagnostics` to preview the same small local diagnostic summary. Nothing is uploaded automatically.\n",
			preview.Agent.MachineReadableCommand,
		)
		return err
	}
	daemon := "unreachable"
	if preview.Diagnostics.Daemon.Reachable {
		daemon = fmt.Sprintf(
			"reachable, ok=%t, version=%s, discovering=%t, sessions=%d",
			preview.Diagnostics.Daemon.OK,
			preview.Diagnostics.Daemon.Version,
			preview.Diagnostics.Daemon.Discovering,
			preview.Diagnostics.Daemon.SessionsLoaded,
		)
	}
	if _, err := fmt.Fprintf(
		writer,
		"\nDiagnostic preview — local only; nothing uploaded\nGenerated: %s\nCLI: %s\nPlatform: %s/%s\nDaemon: %s\n\nNever included:\n",
		preview.Diagnostics.GeneratedAt,
		preview.Diagnostics.CLIVersion,
		preview.Diagnostics.OS,
		preview.Diagnostics.Arch,
		daemon,
	); err != nil {
		return err
	}
	for _, excluded := range preview.Excluded {
		if _, err := fmt.Fprintf(writer, "- %s\n", excluded); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(
		writer,
		"\nAgent report fields:\n- %s\n\nReview this preview, then copy only what you want into the ticket. Agents must ask the user before opening or submitting one.\n",
		strings.Join(preview.Agent.Capture, "\n- "),
	)
	return err
}
