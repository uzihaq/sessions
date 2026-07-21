package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"

	"github.com/uzihaq/sessions/runtime/internal/ledger"
	"github.com/uzihaq/sessions/runtime/internal/recovery"
	sessionruntime "github.com/uzihaq/sessions/runtime/internal/session"
)

// Recovery mutations are serialized inside one daemon. Together with the
// provider UUID check this prevents concurrent --reopen/adopt requests from
// launching two copies of the same conversation.
var recoveryMutationMu sync.Mutex

func (s *Server) handleRecovery(response http.ResponseWriter, request *http.Request, corsOrigin string) {
	switch {
	case request.URL.Path == "/api/recovery" && request.Method == http.MethodGet:
		store, report, ok := s.openRecoveryReport(request.Context(), response, corsOrigin)
		if !ok {
			return
		}
		defer store.Close()
		s.sendJSON(response, http.StatusOK, report, corsOrigin)
	case request.URL.Path == "/api/recovery/reopen" && request.Method == http.MethodPost:
		var body struct {
			Force bool `json:"force,omitempty"`
		}
		if err := readJSON(request, &body); err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return
		}
		recoveryMutationMu.Lock()
		defer recoveryMutationMu.Unlock()
		store, report, ok := s.openRecoveryReport(request.Context(), response, corsOrigin)
		if !ok {
			return
		}
		defer store.Close()
		result := recovery.Reopen(request.Context(), report, s.registry, store.Observations(), recovery.ReopenOptions{Force: body.Force})
		s.sendJSON(response, http.StatusOK, result, corsOrigin)
	case request.URL.Path == "/api/recovery/adopt" && request.Method == http.MethodPost:
		var body struct {
			Target string `json:"target"`
			Name   string `json:"name,omitempty"`
			Force  bool   `json:"force,omitempty"`
		}
		if err := readJSON(request, &body); err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return
		}
		if strings.TrimSpace(body.Target) == "" {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": "target is required"}, corsOrigin)
			return
		}
		recoveryMutationMu.Lock()
		defer recoveryMutationMu.Unlock()
		store, _, ok := s.openRecoveryReport(request.Context(), response, corsOrigin)
		if !ok {
			return
		}
		defer store.Close()
		adoption, err := recovery.ResolveAdoption(body.Target, recovery.AdoptionOptions{})
		if err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return
		}
		result, err := recovery.Adopt(
			request.Context(), adoption, body.Name, s.registry, store.Boundaries(), store.Observations(),
			recovery.AdoptOptions{Force: body.Force},
		)
		if err != nil {
			status := http.StatusBadRequest
			var live *sessionruntime.ConversationLiveError
			var moved *sessionruntime.ConversationMovedError
			if errors.As(err, &live) || errors.As(err, &moved) {
				status = http.StatusConflict
			}
			s.sendJSON(response, status, map[string]any{"error": err.Error(), "laneId": result.LaneID}, corsOrigin)
			return
		}
		s.sendJSON(response, http.StatusCreated, result, corsOrigin)
	default:
		s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "not found", "path": request.URL.Path}, corsOrigin)
	}
}

func (s *Server) openRecoveryReport(
	ctx context.Context,
	response http.ResponseWriter,
	corsOrigin string,
) (*ledger.Store, recovery.Report, bool) {
	store, err := ledger.Open(ctx, ledger.Options{})
	if err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return nil, recovery.Report{}, false
	}
	report, err := recovery.New(recovery.Options{
		Reader: store, RunnerStateDir: s.config.RunnerStateDir,
		ManagedSessions: s.registry.List(false),
	}).Report(ctx)
	if err != nil {
		_ = store.Close()
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return nil, recovery.Report{}, false
	}
	return store, report, true
}
