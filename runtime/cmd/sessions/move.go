package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/uzihaq/sessions/runtime/internal/ledger"
	"github.com/uzihaq/sessions/runtime/internal/migrate"
)

func (a *app) cmdMove(args []string) error {
	const usage = "usage: sessions move <session> --to <target-endpoint> [--token T] [--dry-run] [--allow-dirty]"
	if len(args) == 0 || strings.HasPrefix(args[0], "--") {
		return fail(1, usage)
	}
	sessionArg := args[0]
	args = args[1:]
	target, hasTarget := pluck(&args, "--to")
	if !hasTarget || strings.TrimSpace(target) == "" {
		return fail(1, usage)
	}
	token, hasToken := pluck(&args, "--token")
	if hasToken && token == "" {
		return fail(1, "--token needs a value")
	}
	dryRun := removeFirst(&args, "--dry-run")
	allowDirty := removeFirst(&args, "--allow-dirty")
	if len(args) != 0 {
		return fail(1, "unknown move option %s", args[0])
	}
	client, err := migrate.NewClient(target, token)
	if err != nil {
		return fail(1, "%s", err)
	}
	id, err := a.resolveSessionID(sessionArg)
	if err != nil {
		return err
	}
	sessions, err := a.listSessions(true)
	if err != nil {
		return err
	}
	var source *session
	for index := range sessions {
		if sessions[index].ID == id {
			source = &sessions[index]
			break
		}
	}
	if source == nil {
		return fail(1, "%s", unknownSessionMessage(id))
	}
	ctx := context.Background()
	store, err := ledger.Open(ctx, ledger.Options{})
	if err != nil {
		return fail(2, "open local ledger: %s", err)
	}
	defer store.Close()
	request, err := migrate.ResolveSource(ctx, store, migrate.SourceSession{
		ID: source.ID, Name: source.Name, Tool: source.Tool, Cmd: source.Cmd,
		Args: source.Args, Cwd: source.Cwd, CreatedAt: source.CreatedAt,
	})
	if err != nil {
		return fail(1, "%s", err)
	}
	workspace, err := migrate.PrepareWorkspace(ctx, source.Cwd, source.ID, migrate.WorkspaceOptions{
		AllowDirty: allowDirty, DryRun: dryRun,
	})
	if err != nil {
		return fail(1, "%s", err)
	}
	request.Workspace = workspace
	request.SourceEndpoint = localEndpoint(a)
	result := migrate.MoveResult{
		SourceID: source.ID, TargetEndpoint: client.Endpoint(), Tool: request.Tool, Cwd: request.Cwd,
		ResumeRecipe: append([]string(nil), request.ResumeRecipe...), Workspace: workspace,
		ConversationSize: len(request.ConversationBytes), DryRun: dryRun,
	}
	if dryRun {
		if a.wantJSON {
			return writeJSON(a.stdout, result, true)
		}
		return writeMovePlan(a, result)
	}
	received, err := client.Receive(ctx, request)
	if err != nil {
		return fail(2, "%s", err)
	}
	created, err := client.Create(ctx, request)
	if err != nil {
		return fail(2, "conversation received but target resume failed: %s", err)
	}
	result.TargetID = created.ID
	result.Receive = received
	if err := store.Migrations().RecordMovedTo(ctx, ledger.MovedTo{
		Meta: ledger.Meta{LaneID: source.ID}, TargetEndpoint: client.Endpoint(),
		NewLaneID: created.ID, CheckpointRef: workspace.CheckpointRef,
	}); err != nil {
		return fail(2, "target resumed as %s but local moved_to ledger write failed: %s", created.ID, err)
	}
	if a.wantJSON {
		return writeJSON(a.stdout, result, true)
	}
	if _, err := fmt.Fprintf(a.stdout, "moved %s to %s as %s\n", source.ID, client.Endpoint(), created.ID); err != nil {
		return err
	}
	if workspace.Git {
		ref := workspace.Branch
		if workspace.CheckpointRef != "" {
			ref = workspace.CheckpointRef
		}
		if _, err := fmt.Fprintf(a.stdout, "workspace: %s %s at %s\n", migrate.DisplayRemote(workspace.RemoteURL), ref, workspace.Revision); err != nil {
			return err
		}
	} else if _, err := fmt.Fprintln(a.stdout, "workspace: non-Git cwd was already present on the target"); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(a.stdout, "conversation: %d bytes transferred\n", len(request.ConversationBytes)); err != nil {
		return err
	}
	_, err = fmt.Fprintf(a.stdout, "source still live; kill with sessions kill %s once verified\n", source.ID)
	return err
}

func writeMovePlan(a *app, result migrate.MoveResult) error {
	if _, err := fmt.Fprintf(a.stdout, "dry run: would move %s to %s\n", result.SourceID, result.TargetEndpoint); err != nil {
		return err
	}
	if result.Workspace.Git {
		ref := result.Workspace.Branch
		if result.Workspace.CheckpointRef != "" {
			ref = result.Workspace.CheckpointRef
		}
		if _, err := fmt.Fprintf(a.stdout, "workspace: %s %s at %s\n", migrate.DisplayRemote(result.Workspace.RemoteURL), ref, result.Workspace.Revision); err != nil {
			return err
		}
	} else if _, err := fmt.Fprintln(a.stdout, "workspace: target must already have the non-Git cwd"); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(a.stdout, "conversation: %d bytes would be transferred\n", result.ConversationSize); err != nil {
		return err
	}
	_, err := fmt.Fprintln(a.stdout, "dry run: no files, sessions, or ledger events changed")
	return err
}

func localEndpoint(a *app) string {
	target, err := a.api.target("")
	if err != nil {
		return ""
	}
	target.Path = ""
	target.RawQuery = ""
	return strings.TrimSuffix(target.String(), "/")
}
