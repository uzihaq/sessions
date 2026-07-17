package codexapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func TestConversationTurnStreamsStructuredEventsAndAutoApproves(t *testing.T) {
	serverInput, clientInput := io.Pipe()
	clientOutput, serverOutput := io.Pipe()
	serverDone := make(chan error, 1)
	go func() {
		serverDone <- serveTestTurn(serverInput, serverOutput)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := newClient(ctx, clientInput, clientOutput, func() {
		_ = clientInput.Close()
		_ = clientOutput.Close()
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	conversationID, err := client.NewConversation(ctx, ConversationOptions{
		CWD:    "/tmp",
		Effort: "high",
	})
	if err != nil {
		t.Fatal(err)
	}
	if conversationID != "thread-1" {
		t.Fatalf("conversation id = %q", conversationID)
	}

	stream, err := client.SendUserTurn(ctx, conversationID, "Reply with exactly APPSERVER_OK.")
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately await the result before draining Events. The event queue must
	// not deadlock or drop the pre-response notifications sent by the fake.
	result, err := stream.Result(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Message != "APPSERVER_OK" {
		t.Fatalf("message = %q", result.Message)
	}
	if result.TokenUsage.Last.TotalTokens != 31 {
		t.Fatalf("last token count = %d", result.TokenUsage.Last.TotalTokens)
	}
	if result.Status != "completed" {
		t.Fatalf("status = %q", result.Status)
	}

	var eventTypes []string
	var deltas strings.Builder
	for event := range stream.Events {
		eventTypes = append(eventTypes, fmt.Sprintf("%T", event))
		if delta, ok := event.(AgentMessageDelta); ok {
			deltas.WriteString(delta.Delta)
		}
	}
	if deltas.String() != "APPSERVER_OK" {
		t.Fatalf("agent-message deltas = %q", deltas.String())
	}
	wantTypes := []string{
		"codexapp.ItemStarted",
		"codexapp.AgentMessageDelta",
		"codexapp.AgentMessageDelta",
		"codexapp.ItemCompleted",
		"codexapp.TokenCount",
		"codexapp.TurnComplete",
	}
	if strings.Join(eventTypes, ",") != strings.Join(wantTypes, ",") {
		t.Fatalf("event types = %v, want %v", eventTypes, wantTypes)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

func serveTestTurn(reader io.Reader, writer io.WriteCloser) error {
	defer writer.Close()
	decoder := json.NewDecoder(reader)
	encode := json.NewEncoder(writer)

	request, err := readTestRequest(decoder, "initialize")
	if err != nil {
		return err
	}
	if err := encode.Encode(map[string]any{
		"id": request.ID,
		"result": map[string]any{
			"codexHome":      "/tmp/codex-home",
			"platformFamily": "unix",
			"platformOs":     "macos",
			"userAgent":      "codex/0.144.5",
		},
	}); err != nil {
		return err
	}
	initialized, err := readTestRequest(decoder, "initialized")
	if err != nil {
		return err
	}
	if len(initialized.ID) != 0 {
		return errors.New("initialized unexpectedly had an id")
	}

	request, err = readTestRequest(decoder, "thread/start")
	if err != nil {
		return err
	}
	var threadParams ThreadStartParams
	if err := json.Unmarshal(request.Params, &threadParams); err != nil {
		return err
	}
	if threadParams.CWD != "/tmp" || threadParams.ApprovalPolicy != ApprovalNever || threadParams.Sandbox != SandboxDangerFullAccess {
		return fmt.Errorf("unexpected thread/start params: %+v", threadParams)
	}
	if err := encode.Encode(map[string]any{
		"id": request.ID,
		"result": map[string]any{
			"approvalPolicy": ApprovalNever,
			"cwd":            "/tmp",
			"model":          "test-model",
			"modelProvider":  "test",
			"thread":         map[string]any{"id": "thread-1", "sessionId": "thread-1", "cwd": "/tmp"},
		},
	}); err != nil {
		return err
	}

	request, err = readTestRequest(decoder, "turn/start")
	if err != nil {
		return err
	}
	var turnParams TurnStartParams
	if err := json.Unmarshal(request.Params, &turnParams); err != nil {
		return err
	}
	if turnParams.ThreadID != "thread-1" || turnParams.Effort != "high" || turnParams.ApprovalPolicy != ApprovalNever {
		return fmt.Errorf("unexpected turn/start params: %+v", turnParams)
	}
	if len(turnParams.Input) != 1 || turnParams.Input[0].Text != "Reply with exactly APPSERVER_OK." {
		return fmt.Errorf("unexpected turn input: %+v", turnParams.Input)
	}

	// A server request can arrive while turn/start is outstanding. The client
	// must correlate it independently and opt into the session approval cache.
	if err := encode.Encode(map[string]any{
		"id":     "approval-1",
		"method": "item/commandExecution/requestApproval",
		"params": map[string]any{"threadId": "thread-1", "turnId": "turn-1", "itemId": "command-1", "startedAtMs": 1},
	}); err != nil {
		return err
	}
	approval, err := readTestResponse(decoder)
	if err != nil {
		return err
	}
	if string(approval.ID) != `"approval-1"` {
		return fmt.Errorf("approval response id = %s", approval.ID)
	}
	var approvalResult struct {
		Decision string `json:"decision"`
	}
	if err := json.Unmarshal(approval.Result, &approvalResult); err != nil {
		return err
	}
	if approvalResult.Decision != "acceptForSession" {
		return fmt.Errorf("approval decision = %q", approvalResult.Decision)
	}

	// Exercise the valid race where streaming starts before turn/start's
	// response reaches the client.
	for _, message := range []map[string]any{
		{
			"method": "item/started",
			"params": map[string]any{
				"threadId": "thread-1", "turnId": "turn-1", "startedAtMs": 10,
				"item": map[string]any{"id": "agent-1", "type": "agentMessage", "text": ""},
			},
		},
		{
			"method": "item/agentMessage/delta",
			"params": map[string]any{"threadId": "thread-1", "turnId": "turn-1", "itemId": "agent-1", "delta": "APPSERVER_"},
		},
	} {
		if err := encode.Encode(message); err != nil {
			return err
		}
	}
	if err := encode.Encode(map[string]any{
		"id": request.ID,
		"result": map[string]any{
			"turn": map[string]any{"id": "turn-1", "items": []any{}, "status": "inProgress"},
		},
	}); err != nil {
		return err
	}

	finalPhase := "final"
	for _, message := range []map[string]any{
		{
			"method": "item/agentMessage/delta",
			"params": map[string]any{"threadId": "thread-1", "turnId": "turn-1", "itemId": "agent-1", "delta": "OK"},
		},
		{
			"method": "item/completed",
			"params": map[string]any{
				"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 20,
				"item": map[string]any{"id": "agent-1", "type": "agentMessage", "text": "APPSERVER_OK", "phase": finalPhase},
			},
		},
		{
			"method": "thread/tokenUsage/updated",
			"params": map[string]any{
				"threadId": "thread-1", "turnId": "turn-1",
				"tokenUsage": map[string]any{
					"last":  map[string]any{"cachedInputTokens": 2, "inputTokens": 20, "outputTokens": 11, "reasoningOutputTokens": 0, "totalTokens": 31},
					"total": map[string]any{"cachedInputTokens": 2, "inputTokens": 20, "outputTokens": 11, "reasoningOutputTokens": 0, "totalTokens": 31},
				},
			},
		},
		{
			"method": "turn/completed",
			"params": map[string]any{
				"threadId": "thread-1",
				"turn": map[string]any{
					"id": "turn-1", "status": "completed",
					"items": []any{map[string]any{"id": "agent-1", "type": "agentMessage", "text": "APPSERVER_OK", "phase": finalPhase}},
				},
			},
		},
	} {
		if err := encode.Encode(message); err != nil {
			return err
		}
	}
	return nil
}

type testMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
}

func readTestRequest(decoder *json.Decoder, method string) (testMessage, error) {
	var message testMessage
	if err := decoder.Decode(&message); err != nil {
		return testMessage{}, err
	}
	if message.Method != method {
		return testMessage{}, fmt.Errorf("method = %q, want %q", message.Method, method)
	}
	return message, nil
}

func readTestResponse(decoder *json.Decoder) (testMessage, error) {
	var message testMessage
	if err := decoder.Decode(&message); err != nil {
		return testMessage{}, err
	}
	if message.Method != "" || len(message.ID) == 0 || len(message.Result) == 0 {
		return testMessage{}, fmt.Errorf("not a response: %+v", message)
	}
	return message, nil
}
