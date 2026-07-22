package recap

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/somewhere-tech/sessions/runtime/internal/session"
	"github.com/somewhere-tech/sessions/runtime/internal/state"
)

func TestGenerateCachesByInputProviderAndModel(t *testing.T) {
	calls := 0
	service := NewServiceWithRunner(t.TempDir(), func(_ context.Context, settings state.RecapSettings, prompt string) (string, error) {
		calls++
		if settings.Provider != state.RecapProviderCodex || settings.Model != "luna" {
			t.Fatalf("settings = %#v", settings)
		}
		if !strings.Contains(prompt, "SESSIONS_DAY_JSON") || !strings.Contains(prompt, "Session A") {
			t.Fatalf("prompt = %q", prompt)
		}
		if strings.Contains(prompt, `"id":"private-session-id"`) {
			t.Fatalf("provider prompt leaked a durable session id: %q", prompt)
		}
		return "# Daily recap\n\nWorked on Sessions.", nil
	})
	input := DayInput{Date: "2026-07-22", Timezone: "America/Los_Angeles", Activities: []session.DailyActivity{{ID: "private-session-id", Name: "Session A"}}}
	settings := state.RecapSettings{Provider: "CODEX", Model: " luna "}
	first, err := service.Generate(context.Background(), settings, input, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Generate(context.Background(), settings, input, false)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || first.InputDigest != second.InputDigest || first.Markdown != second.Markdown {
		t.Fatalf("calls=%d first=%#v second=%#v", calls, first, second)
	}
	if _, err := service.Generate(context.Background(), state.DefaultRecapSettings(), input, false); err == nil {
		t.Fatal("off recap unexpectedly generated")
	}
}

func TestProviderInputAliasesHierarchyAndBoundsActivityCount(t *testing.T) {
	activities := make([]session.DailyActivity, maxPromptActivities+2)
	for index := range activities {
		activities[index] = session.DailyActivity{ID: fmt.Sprintf("secret-id-%d", index), Name: "Session", CWD: "/private/project"}
	}
	activities[3].ID = "child-secret-id"
	activities[3].ParentSessionID = activities[2].ID
	encoded, err := encodeProviderInput(DayInput{Date: "2026-07-22", Activities: activities})
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{`"id":`, "child-secret-id", `"workdir":"/private/project"`} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("provider input contains %q: %s", forbidden, text)
		}
	}
	for _, required := range []string{`"parent":"activity-001"`, `"workdir":"project"`, `"omittedActivities":2`} {
		if !strings.Contains(text, required) {
			t.Fatalf("provider input missing %q: %s", required, text)
		}
	}
}

func TestProviderArgumentsDisableToolsAndPersistence(t *testing.T) {
	claude := strings.Join(providerArguments(state.RecapSettings{Provider: state.RecapProviderClaude, Model: "tera"}), " ")
	if !strings.Contains(claude, "--tools  --strict-mcp-config --no-session-persistence") || !strings.Contains(claude, "--model tera") {
		t.Fatalf("claude args = %q", claude)
	}
	codex := strings.Join(providerArguments(state.RecapSettings{Provider: state.RecapProviderCodex, Model: "luna"}), " ")
	for _, required := range []string{"--ask-for-approval never", "--model luna", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox read-only"} {
		if !strings.Contains(codex, required) {
			t.Fatalf("codex args %q missing %q", codex, required)
		}
	}
}

func TestProviderEnvironmentPrefersExistingCLIAuthentication(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "do-not-forward")
	t.Setenv("OPENAI_API_KEY", "do-not-forward")
	t.Setenv("SESSIONS_RECAP_TEST_KEEP", "kept")
	environment := strings.Join(providerEnvironment(), "\n")
	for _, forbidden := range []string{"ANTHROPIC_API_KEY=", "OPENAI_API_KEY="} {
		if strings.Contains(environment, forbidden) {
			t.Fatalf("provider environment contains %s", forbidden)
		}
	}
	if !strings.Contains(environment, "SESSIONS_RECAP_TEST_KEEP=kept") {
		t.Fatal("provider environment dropped ordinary variables")
	}
}
