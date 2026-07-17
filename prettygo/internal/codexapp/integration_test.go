package codexapp

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// Run explicitly with:
//
//	CODEXAPP_INTEGRATION=1 go test -v ./internal/codexapp -run TestRealAppServerTurn
func TestRealAppServerTurn(t *testing.T) {
	if os.Getenv("CODEXAPP_INTEGRATION") != "1" {
		t.Skip("set CODEXAPP_INTEGRATION=1 to spend a real Codex turn")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	scratch, err := os.MkdirTemp("/tmp", "pretty-pty-codexapp-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(scratch)

	clientOptions := Options{}
	if socketPath := os.Getenv("CODEXAPP_SOCKET"); socketPath != "" {
		clientOptions.SkipDaemonStart = true
		clientOptions.SocketPath = socketPath
	}
	client, err := NewClient(ctx, clientOptions)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	conversationID, err := client.NewConversation(ctx, ConversationOptions{CWD: scratch})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CONVERSATION_ID %s", conversationID)
	t.Logf("SCRATCH_CWD %s", scratch)

	stream, err := client.SendUserTurn(ctx, conversationID, "Reply with exactly APPSERVER_OK.")
	if err != nil {
		t.Fatal(err)
	}
	var deltas strings.Builder
	var sawTokenCount, sawTurnComplete bool
	sequence := 0
	for event := range stream.Events {
		sequence++
		encoded, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("EVENT %02d %T %s", sequence, event, encoded)
		switch event := event.(type) {
		case AgentMessageDelta:
			deltas.WriteString(event.Delta)
		case TokenCount:
			if event.Usage.Last.TotalTokens > 0 {
				sawTokenCount = true
			}
		case TurnComplete:
			sawTurnComplete = event.Status == "completed"
		}
	}
	result, err := stream.Result(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("RESULT %s", mustJSON(t, result))
	if deltas.String() != "APPSERVER_OK" {
		t.Fatalf("structured agent-message deltas = %q", deltas.String())
	}
	if result.Message != "APPSERVER_OK" {
		t.Fatalf("final assistant message = %q", result.Message)
	}
	if !sawTokenCount || result.TokenUsage.Last.TotalTokens <= 0 {
		t.Fatalf("missing positive token count: %+v", result.TokenUsage)
	}
	if !sawTurnComplete || result.Status != "completed" {
		t.Fatalf("missing completed turn: %+v", result)
	}
}

func TestRealAppServerFallbackHandshake(t *testing.T) {
	if os.Getenv("CODEXAPP_FALLBACK_INTEGRATION") != "1" {
		t.Skip("set CODEXAPP_FALLBACK_INTEGRATION=1 to test the unmanaged-install fallback")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, err := NewClient(ctx, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if endpoint := client.RemoteEndpoint(); !strings.HasPrefix(endpoint, "unix:///tmp/pretty-pty-appserver-") {
		t.Fatalf("fallback endpoint = %q", endpoint)
	} else {
		t.Logf("REMOTE_ENDPOINT %s", endpoint)
	}
	conversationID, err := client.NewConversation(ctx, ConversationOptions{CWD: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CONVERSATION_ID %s", conversationID)
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
