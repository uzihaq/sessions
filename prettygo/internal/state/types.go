package state

import "encoding/json"

type SessionTool string

const (
	ToolClaude         SessionTool = "claude-code"
	ToolCodex          SessionTool = "codex"
	ToolTerminal       SessionTool = "terminal"
	ToolLane           SessionTool = "lane"
	KindLane                       = "lane"
	KindCodexAppServer             = "codex-app-server"
)

type SessionInfo struct {
	ID                string      `json:"id"`
	Name              string      `json:"name,omitempty"`
	Kind              string      `json:"kind,omitempty"`
	SpecPath          string      `json:"specPath,omitempty"`
	Cmd               string      `json:"cmd"`
	Args              []string    `json:"args"`
	Cwd               string      `json:"cwd"`
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
}

type CreateSessionRequest struct {
	Cmd       string            `json:"cmd,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Cols      int               `json:"cols,omitempty"`
	Rows      int               `json:"rows,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Name      string            `json:"name,omitempty"`
	Kind      string            `json:"kind,omitempty"`
	SpecPath  string            `json:"specPath,omitempty"`
	OnIdle    string            `json:"onIdle,omitempty"`
	WaitReady bool              `json:"waitReady,omitempty"`
	Force     bool              `json:"force,omitempty"`
}

type ClaudeEventsWindow struct {
	Events     []json.RawMessage
	NextIndex  int64
	TotalCount int64
	StartIndex int64
	EndIndex   int64
}
