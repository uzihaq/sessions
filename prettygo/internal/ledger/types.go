// Package ledger stores the durable, append-only history used to recover
// Pretty lanes after daemon or runner loss. It deliberately stores lifecycle
// facts and resume identities only; prompts and terminal bytes do not belong
// in this package.
package ledger

import (
	"context"
	"encoding/json"
	"time"
)

const SchemaVersion = 1

// EventType is one of the lifecycle facts understood by Fold.
type EventType string

const (
	EventCreated           EventType = "created"
	EventLaunchStarted     EventType = "launch_started"
	EventRunnerReady       EventType = "runner_ready"
	EventProviderBound     EventType = "provider_bound"
	EventAttached          EventType = "attached"
	EventActivity          EventType = "activity"
	EventIdle              EventType = "idle"
	EventRenamed           EventType = "renamed"
	EventUserKillRequested EventType = "user_kill_requested"
	EventRunnerExited      EventType = "runner_exited"
	EventRunnerLost        EventType = "runner_lost"
	EventReaped            EventType = "reaped"
	EventReopened          EventType = "reopened"
	EventDaemonRestart     EventType = "daemon_restart"
	EventMovedTo           EventType = "moved_to"
	EventMovedFrom         EventType = "moved_from"
	EventProviderRebound   EventType = "provider_rebound"
)

// Actor identifies the subsystem that observed or requested a lifecycle fact.
// It must never contain user content.
type Actor string

const (
	ActorUser     Actor = "user"
	ActorDaemon   Actor = "daemon"
	ActorRunner   Actor = "runner"
	ActorProvider Actor = "provider"
	ActorRecovery Actor = "recovery"
	ActorAdopt    Actor = "adopt"
)

// Event is one immutable lane_events row.
type Event struct {
	Seq           int64
	EventID       string
	LaneID        string
	Type          EventType
	AtMS          int64
	Actor         Actor
	SchemaVersion int
	Payload       json.RawMessage
}

// Meta supplies the columns shared by typed event writers. EventID and AtMS
// may be omitted; the Store then supplies a UUID and its current clock.
type Meta struct {
	EventID string
	LaneID  string
	AtMS    int64
	Actor   Actor
}

// Created is the only payload accepted by the creation write-ahead boundary.
// ResumeArgv is a reconstructed provider resume command, not the original
// process argv. LaneUUID intentionally mirrors LaneID inside the payload so a
// copied payload remains self-identifying.
type Created struct {
	Meta
	Name         string
	Tool         string
	Cwd          string
	ResumeArgv   []string
	LaneUUID     string
	ProviderUUID string
}

type UserKill struct {
	Meta
}

type Observation struct {
	Meta
}

type ProviderBound struct {
	Meta
	ProviderUUID string
	ResumeArgv   []string
}

// ProviderRebound records an explicit forced transfer of the provider
// identity from the lane in Meta to NewLaneID. It does not terminate or reap
// the previous lane; the fact only changes which lane owns the binding.
type ProviderRebound struct {
	Meta
	ProviderUUID string
	NewLaneID    string
}

type ActivitySource string

const (
	ActivityHumanInput    ActivitySource = "human_input"
	ActivityProviderEvent ActivitySource = "provider_event"
)

type Activity struct {
	Meta
	Source ActivitySource
}

type Rename struct {
	Meta
	Name string
}

type RunnerExit struct {
	Meta
	Code   *int
	Signal *string
}

type Reopened struct {
	Meta
	NewLaneID string
}

// MovedTo and MovedFrom are provenance facts for resume-elsewhere. They do
// not imply that either runner was killed.
type MovedTo struct {
	Meta
	TargetEndpoint string
	NewLaneID      string
	CheckpointRef  string
}

type MovedFrom struct {
	Meta
	SourceEndpoint string
	SourceLaneID   string
}

// BoundaryWriter exposes actions that must durably commit before their
// irreversible side effect. Creation and provider-rebind errors forbid
// launch; kill errors forbid sending the runner's kill frame.
type BoundaryWriter interface {
	RecordCreated(context.Context, Created) error
	RecordProviderRebound(context.Context, ProviderRebound) error
	RecordUserKill(context.Context, UserKill) error
}

// ObservationWriter intentionally has no RecordCreated or RecordUserKill
// method. Passing this interface to asynchronous lifecycle code makes it
// impossible for that code to create a tombstone at compile time.
type ObservationWriter interface {
	RecordLaunchStarted(context.Context, Observation) error
	RecordRunnerReady(context.Context, Observation) error
	RecordProviderBound(context.Context, ProviderBound) error
	RecordAttached(context.Context, Observation) error
	RecordActivity(context.Context, Activity) error
	RecordIdle(context.Context, Observation) error
	RecordRenamed(context.Context, Rename) error
	RecordRunnerExited(context.Context, RunnerExit) error
	RecordRunnerLost(context.Context, Observation) error
	RecordReaped(context.Context, Observation) error
	RecordReopened(context.Context, Reopened) error
	RecordDaemonRestart(context.Context, Observation) error
}

// MigrationWriter is separate from lifecycle observations because moves are
// explicit user actions and do not alter managed-runner liveness.
type MigrationWriter interface {
	RecordMovedTo(context.Context, MovedTo) error
	RecordMovedFrom(context.Context, MovedFrom) error
}

type Options struct {
	Path             string
	BusyTimeout      time.Duration
	ActivityCoalesce time.Duration
	Clock            func() time.Time
	NewEventID       func() (string, error)
}
