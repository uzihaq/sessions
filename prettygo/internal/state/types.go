package state

import "encoding/json"

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
	ID                string      `json:"id"`
	Name              string      `json:"name,omitempty"`
	Description       string      `json:"description"`
	DescriptionSource string      `json:"description_source,omitempty"`
	Kind              string      `json:"kind,omitempty"`
	SpecPath          string      `json:"specPath,omitempty"`
	Cmd               string      `json:"cmd"`
	Args              []string    `json:"args"`
	Cwd               string      `json:"cwd"`
	Profile           string      `json:"profile,omitempty"`
	ConfigDir         string      `json:"config_dir,omitempty"`
	WorktreePath      string      `json:"worktree_path,omitempty"`
	Branch            string      `json:"branch,omitempty"`
	Base              string      `json:"base,omitempty"`
	SourceRepo        string      `json:"source_repo,omitempty"`
	Cols              int         `json:"cols"`
	Rows              int         `json:"rows"`
	CreatedAt         int64       `json:"createdAt"`
	PID               int         `json:"pid"`
	Tool              SessionTool `json:"tool"`
	Working           bool        `json:"working"`
	LastDataAt        int64       `json:"lastDataAt"`
	LastUserMessageAt *int64      `json:"lastUserMessageAt"`
	Exited            bool        `json:"exited"`
	ExitCode          *int        `json:"exitCode"`
	ExitSignal        *string     `json:"exitSignal"`
	ExitedAt          *int64      `json:"exitedAt"`
	ClaudeCustomTitle string      `json:"claudeCustomTitle,omitempty"`
	ClaudeAITitle     string      `json:"claudeAiTitle,omitempty"`
	OnIdle            string      `json:"onIdle,omitempty"`
	Model             string      `json:"model,omitempty"`
	Effort            string      `json:"effort,omitempty"`
	Fast              bool        `json:"fast,omitempty"`
	ConversationID    string      `json:"conversationId,omitempty"`
	RemoteEndpoint    string      `json:"remoteEndpoint,omitempty"`
	ClaudeSessionID   string      `json:"claudeSessionId,omitempty"`
	CreatorKind       string      `json:"creator_kind,omitempty"`
	CreatorID         string      `json:"creator_id,omitempty"`
	ParentSessionID   string      `json:"parent_session_id,omitempty"`
	CreatorAncestry   []string    `json:"creator_ancestry,omitempty"`
	RootCreatorKind   string      `json:"root_creator_kind,omitempty"`
	RootCreatorID     string      `json:"root_creator_id,omitempty"`
	ProvenanceStatus  string      `json:"provenance_status,omitempty"`
}

type CreateSessionRequest struct {
	Cmd         string            `json:"cmd,omitempty"`
	Args        []string          `json:"args,omitempty"`
	Cwd         string            `json:"cwd,omitempty"`
	Cols        int               `json:"cols,omitempty"`
	Rows        int               `json:"rows,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Name        string            `json:"name,omitempty"`
	Description string            `json:"description,omitempty"`
	Profile     string            `json:"profile,omitempty"`
	Worktree    bool              `json:"worktree,omitempty"`
	Base        string            `json:"base,omitempty"`
	Kind        string            `json:"kind,omitempty"`
	SpecPath    string            `json:"specPath,omitempty"`
	OnIdle      string            `json:"onIdle,omitempty"`
	WaitReady   bool              `json:"waitReady,omitempty"`
	Force       bool              `json:"force,omitempty"`
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

type ClaudeEventsWindow struct {
	Events     []json.RawMessage
	NextIndex  int64
	TotalCount int64
	StartIndex int64
	EndIndex   int64
}
