package state

import "encoding/json"

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

type SessionTool string

const (
	ToolClaude              SessionTool = "claude-code"
	ToolCodex               SessionTool = "codex"
	ToolTerminal            SessionTool = "terminal"
	ToolLane                SessionTool = "lane"
	KindLane                            = "lane"
	KindCodexAppServer                  = "codex-app-server"
	KindClaudeStructured                = "claude-structured"
	DescriptionExplicit                 = "explicit"
	DescriptionFirstMessage             = "first-message"
)

type SessionInfo struct {
	ID                string            `json:"id"`
	Name              string            `json:"name,omitempty"`
	Description       string            `json:"description"`
	DescriptionSource string            `json:"description_source,omitempty"`
	Tags              map[string]string `json:"tags,omitempty"`
	Kind              string            `json:"kind,omitempty"`
	SpecPath          string            `json:"specPath,omitempty"`
	Cmd               string            `json:"cmd"`
	Args              []string          `json:"args"`
	Cwd               string            `json:"cwd"`
	Profile           string            `json:"profile,omitempty"`
	ConfigDir         string            `json:"config_dir,omitempty"`
	WorktreePath      string            `json:"worktree_path,omitempty"`
	Branch            string            `json:"branch,omitempty"`
	Base              string            `json:"base,omitempty"`
	SourceRepo        string            `json:"source_repo,omitempty"`
	Cols              int               `json:"cols"`
	Rows              int               `json:"rows"`
	CreatedAt         int64             `json:"createdAt"`
	PID               int               `json:"pid"`
	RunnerProtocol    int               `json:"runnerProtocol"`
	RunnerVersion     string            `json:"runnerVersion,omitempty"`
	Tool              SessionTool       `json:"tool"`
	Working           bool              `json:"working"`
	LastDataAt        int64             `json:"lastDataAt"`
	LastUserMessageAt *int64            `json:"lastUserMessageAt"`
	IdleReason        string            `json:"idleReason,omitempty"`
	IdleDetail        string            `json:"idleDetail,omitempty"`
	IdleSince         *int64            `json:"idleSince,omitempty"`
	LastSummary       string            `json:"lastSummary,omitempty"`
	Exited            bool              `json:"exited"`
	ExitCode          *int              `json:"exitCode"`
	ExitSignal        *string           `json:"exitSignal"`
	ExitedAt          *int64            `json:"exitedAt"`
	ClaudeCustomTitle string            `json:"claudeCustomTitle,omitempty"`
	ClaudeAITitle     string            `json:"claudeAiTitle,omitempty"`
	OnIdle            string            `json:"onIdle,omitempty"`
	Model             string            `json:"model,omitempty"`
	Effort            string            `json:"effort,omitempty"`
	Fast              bool              `json:"fast,omitempty"`
	ConversationID    string            `json:"conversationId,omitempty"`
	RemoteEndpoint    string            `json:"remoteEndpoint,omitempty"`
	ClaudeSessionID   string            `json:"claudeSessionId,omitempty"`
	CreatorKind       string            `json:"creator_kind,omitempty"`
	CreatorID         string            `json:"creator_id,omitempty"`
	ParentSessionID   string            `json:"parent_session_id,omitempty"`
	// DisplayParentSessionID is a user-controlled organizational override.
	// nil preserves the creator-ledger hierarchy, a pointer to "" makes the
	// session a visual root, and any other value groups it under that session.
	// It never rewrites trusted creator provenance.
	DisplayParentSessionID *string  `json:"display_parent_session_id,omitempty"`
	CreatorAncestry        []string `json:"creator_ancestry,omitempty"`
	RootCreatorKind        string   `json:"root_creator_kind,omitempty"`
	RootCreatorID          string   `json:"root_creator_id,omitempty"`
	ProvenanceStatus       string   `json:"provenance_status,omitempty"`
}

const (
	IdleReasonNeverStarted = "never-started"
	IdleReasonCompleted    = "completed"
	IdleReasonNeedsInput   = "needs-input"
	IdleReasonFailed       = "failed"
)

type CreateSessionRequest struct {
	Cmd         string                `json:"cmd,omitempty"`
	Args        []string              `json:"args,omitempty"`
	Cwd         string                `json:"cwd,omitempty"`
	Cols        int                   `json:"cols,omitempty"`
	Rows        int                   `json:"rows,omitempty"`
	Env         map[string]string     `json:"env,omitempty"`
	Name        string                `json:"name,omitempty"`
	Description string                `json:"description,omitempty"`
	Tags        map[string]string     `json:"tags,omitempty"`
	Profile     string                `json:"profile,omitempty"`
	Worktree    bool                  `json:"worktree,omitempty"`
	Base        string                `json:"base,omitempty"`
	Kind        string                `json:"kind,omitempty"`
	SpecPath    string                `json:"specPath,omitempty"`
	OnIdle      string                `json:"onIdle,omitempty"`
	WaitReady   bool                  `json:"waitReady,omitempty"`
	Force       bool                  `json:"force,omitempty"`
	Claude      *ClaudeSessionOptions `json:"claude,omitempty"`
	// CreatorSessionID and CreatorOwnerID are populated from trusted HTTP
	// headers at the daemon boundary. They are deliberately not JSON fields.
	CreatorSessionID string `json:"-"`
	CreatorOwnerID   string `json:"-"`
	ConfigDir        string `json:"-"`
	WorktreePath     string `json:"-"`
	WorktreeBranch   string `json:"-"`
	WorktreeBase     string `json:"-"`
	SourceRepo       string `json:"-"`
}

// ClaudeSessionOptions are explicit per-session overrides. Empty fields use
// the persisted Sessions default; "inherit" asks Sessions to defer to Claude
// itself for that setting.
type ClaudeSessionOptions struct {
	RemoteControl           string `json:"remoteControl,omitempty"`
	PermissionMode          string `json:"permissionMode,omitempty"`
	Model                   string `json:"model,omitempty"`
	Effort                  string `json:"effort,omitempty"`
	Chrome                  string `json:"chrome,omitempty"`
	SomewhereMCP            string `json:"somewhereMcp,omitempty"`
	RemoteControlNamePrefix string `json:"remoteControlNamePrefix,omitempty"`
}

type ClaudeEventsWindow struct {
	Events     []json.RawMessage
	NextIndex  int64
	TotalCount int64
	StartIndex int64
	EndIndex   int64
}
