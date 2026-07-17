package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/uzihaq/pretty-pty/prettygo/internal/codexapp"
)

func TestModelsCommandPrintsHumanAndJSONCatalog(t *testing.T) {
	catalog := []codexapp.Model{{
		ID: "alpha", DisplayName: "Alpha", IsDefault: true, DefaultReasoningEffort: "medium",
		SupportedReasoningEfforts: []codexapp.ReasoningEffortOption{{ReasoningEffort: "low"}, {ReasoningEffort: "high"}},
		ServiceTiers:              []codexapp.ModelServiceTier{{ID: "priority", Name: "Fast"}},
	}}
	for _, test := range []struct {
		name     string
		json     bool
		validate func(*testing.T, string)
	}{
		{
			name: "human",
			validate: func(t *testing.T, output string) {
				for _, want := range []string{"MODEL", "DEFAULT EFFORT", "alpha", "Alpha", "yes", "medium", "low,high", "priority"} {
					if !strings.Contains(output, want) {
						t.Fatalf("human output %q missing %q", output, want)
					}
				}
			},
		},
		{
			name: "json", json: true,
			validate: func(t *testing.T, output string) {
				var decoded []codexapp.Model
				if err := json.Unmarshal([]byte(output), &decoded); err != nil {
					t.Fatal(err)
				}
				if len(decoded) != 1 || decoded[0].ID != "alpha" || len(decoded[0].ServiceTiers) != 1 {
					t.Fatalf("JSON catalog = %#v", decoded)
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			application := &app{
				stdout: &output, wantJSON: test.json,
				listModels: func(context.Context) ([]codexapp.Model, error) { return catalog, nil },
			}
			if err := application.cmdModels(nil); err != nil {
				t.Fatal(err)
			}
			test.validate(t, output.String())
		})
	}
}
