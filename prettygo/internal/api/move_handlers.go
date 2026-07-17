package api

import (
	"errors"
	"io"
	"net/http"

	"github.com/uzihaq/pretty-pty/prettygo/internal/migrate"
)

func (s *Server) handleMoveRoute(response http.ResponseWriter, request *http.Request, corsOrigin string) bool {
	if request.URL.Path != "/api/migrate/receive" {
		return false
	}
	if request.Method != http.MethodPost {
		s.sendJSON(response, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"}, corsOrigin)
		return true
	}
	request.Body = http.MaxBytesReader(response, request.Body, migrate.MaxReceiveBodyBytes)
	var body migrate.ReceiveRequest
	if err := migrate.DecodeReceive(request.Body, &body); err != nil {
		status := http.StatusBadRequest
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) || errors.Is(err, io.ErrUnexpectedEOF) {
			status = http.StatusRequestEntityTooLarge
		}
		s.sendJSON(response, status, map[string]any{"error": err.Error()}, corsOrigin)
		return true
	}
	result, err := migrate.Receive(request.Context(), body, migrate.ReceiveOptions{})
	if err != nil {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
		return true
	}
	s.sendJSON(response, http.StatusCreated, result, corsOrigin)
	return true
}
