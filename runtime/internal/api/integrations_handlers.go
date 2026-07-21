package api

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/uzihaq/sessions/runtime/internal/integrations"
)

func (s *Server) handleIntegrationsRoute(response http.ResponseWriter, request *http.Request, corsOrigin string) bool {
	path := request.URL.Path
	matched := path == "/api/history" || strings.HasPrefix(path, "/api/history/") || path == "/api/errors"
	if !matched {
		return false
	}
	if request.Method != http.MethodGet {
		s.sendJSON(response, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"}, corsOrigin)
		return true
	}
	for _, info := range s.registry.List(true) {
		if session, ok := s.registry.Get(info.ID); ok {
			if err := s.integrationEndpoints.TrackSession(session); err != nil {
				log.Printf("[integrations] track runner %s: %v", info.ID, err)
			}
		}
	}
	if err := s.integrationEndpoints.ObserveFailures(s.registry.List(true)); err != nil {
		log.Printf("[integrations] observe runner failures: %v", err)
	}

	switch {
	case path == "/api/history":
		history, err := s.integrationEndpoints.History(s.registry.List(true))
		if err != nil {
			s.integrationError(response, corsOrigin, "history list failed", err)
			return true
		}
		s.sendJSON(response, http.StatusOK, history, corsOrigin)
		return true
	case path == "/api/errors":
		since, err := errorsSince(request)
		if err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return true
		}
		feed, err := s.integrationEndpoints.ErrorFeed(since)
		if err != nil {
			s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
			return true
		}
		s.sendJSON(response, http.StatusOK, feed, corsOrigin)
		return true
	}

	id, raw, ok := historyPath(path)
	if !ok {
		s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "not found", "path": path}, corsOrigin)
		return true
	}
	if raw {
		encoded, err := s.integrationEndpoints.Raw(s.registry.List(true), id)
		if errors.Is(err, integrations.ErrHistoryNotFound) {
			s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "history session not found", "id": id}, corsOrigin)
			return true
		}
		if err != nil {
			s.integrationError(response, corsOrigin, "raw history read failed", err)
			return true
		}
		s.sendIntegrationBytes(response, http.StatusOK, "application/octet-stream", encoded, corsOrigin)
		return true
	}

	format := request.URL.Query().Get("format")
	if format == "" {
		format = "json"
	}
	if format != "json" && format != "text" {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": "format must be json or text"}, corsOrigin)
		return true
	}
	transcript, err := s.integrationEndpoints.Transcript(s.registry.List(true), id)
	if errors.Is(err, integrations.ErrHistoryNotFound) {
		s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "history session not found", "id": id}, corsOrigin)
		return true
	}
	if err != nil {
		s.integrationError(response, corsOrigin, "history transcript failed", err)
		return true
	}
	if format == "text" {
		response.Header().Set("X-Sessions-Schema-Version", strconv.Itoa(integrations.SchemaVersion))
		s.sendIntegrationBytes(response, http.StatusOK, "text/plain; charset=utf-8", []byte(formatTranscriptText(transcript)), corsOrigin)
		return true
	}
	s.sendJSON(response, http.StatusOK, transcript, corsOrigin)
	return true
}

func historyPath(path string) (id string, raw bool, ok bool) {
	const prefix = "/api/history/"
	if !strings.HasPrefix(path, prefix) {
		return "", false, false
	}
	rest := strings.TrimPrefix(path, prefix)
	if strings.HasSuffix(rest, "/raw") {
		rest = strings.TrimSuffix(rest, "/raw")
		raw = true
	}
	if rest == "" || strings.Contains(rest, "/") {
		return "", false, false
	}
	return rest, raw, true
}

func errorsSince(request *http.Request) (uint64, error) {
	raw := request.URL.Query().Get("since")
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, errors.New("since must be a non-negative integer sequence")
	}
	return value, nil
}

func (s *Server) integrationError(response http.ResponseWriter, corsOrigin, summary string, err error) {
	if _, recordErr := s.integrationEndpoints.Emit(integrations.ErrorInput{
		Kind: "daemon_error", Summary: summary, Detail: err.Error(),
	}); recordErr != nil {
		log.Printf("[integrations] record daemon error: %v", recordErr)
	}
	s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
}

func (s *Server) sendIntegrationBytes(
	response http.ResponseWriter,
	status int,
	contentType string,
	body []byte,
	corsOrigin string,
) {
	response.Header().Set("Content-Type", contentType)
	if corsOrigin != "" {
		response.Header().Set("Access-Control-Allow-Origin", corsOrigin)
	}
	response.Header().Set("Vary", "Origin")
	response.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
	response.Header().Set("Access-Control-Allow-Headers", "content-type, authorization")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func formatTranscriptText(transcript integrations.TranscriptResponse) string {
	var output strings.Builder
	for index, message := range transcript.Messages {
		if index > 0 {
			output.WriteByte('\n')
		}
		fmt.Fprintf(&output, "[%s", message.Role)
		if message.Timestamp != nil {
			fmt.Fprintf(&output, " %s", *message.Timestamp)
		}
		output.WriteString("]\n")
		output.WriteString(message.Text)
		output.WriteByte('\n')
	}
	return output.String()
}
