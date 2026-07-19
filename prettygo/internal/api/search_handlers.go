package api

import (
	"net/http"
	"path/filepath"
	"strconv"

	historysearch "github.com/uzihaq/pretty-pty/prettygo/internal/search"
)

func (s *Server) handleSearchRoute(response http.ResponseWriter, request *http.Request, corsOrigin string) bool {
	if request.URL.Path != "/api/search" {
		return false
	}
	if request.Method != http.MethodGet {
		s.sendJSON(response, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"}, corsOrigin)
		return true
	}
	options, err := searchOptions(request)
	if err != nil {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
		return true
	}
	indexRoot := s.config.UserStateRoot
	if indexRoot == "" {
		indexRoot = s.config.StateRoot
	}
	indexPath := filepath.Join(indexRoot, "search-index.db")
	result, err := historysearch.Run(request.Context(), s.integrationEndpoints, s.registry.List(true), options, indexPath)
	if err != nil {
		status := http.StatusInternalServerError
		if historysearch.IsOptionError(err) {
			status = http.StatusBadRequest
		}
		s.sendJSON(response, status, map[string]any{"error": err.Error()}, corsOrigin)
		return true
	}
	s.sendJSON(response, http.StatusOK, result, corsOrigin)
	return true
}

func searchOptions(request *http.Request) (historysearch.Options, error) {
	query := request.URL.Query()
	options := historysearch.Options{
		Query: query.Get("q"), SessionID: query.Get("session"),
		Role: query.Get("role"), Tool: query.Get("tool"),
	}
	if raw := query.Get("regex"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return historysearch.Options{}, &searchQueryError{message: "regex must be true or false"}
		}
		options.Regex = value
	}
	if raw := query.Get("ranked"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return historysearch.Options{}, &searchQueryError{message: "ranked must be true or false"}
		}
		options.Ranked = value
	}
	if raw := query.Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			return historysearch.Options{}, &searchQueryError{message: "limit must be an integer"}
		}
		if value < 1 || value > historysearch.MaxLimit {
			return historysearch.Options{}, &searchQueryError{message: "limit must be between 1 and " + strconv.Itoa(historysearch.MaxLimit)}
		}
		options.Limit = value
	}
	return options, nil
}

type searchQueryError struct{ message string }

func (e *searchQueryError) Error() string { return e.message }
