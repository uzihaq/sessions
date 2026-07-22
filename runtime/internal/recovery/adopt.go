package recovery

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/somewhere-tech/sessions/runtime/internal/ledger"
	"github.com/somewhere-tech/sessions/runtime/internal/state"
	"github.com/somewhere-tech/sessions/runtime/internal/watch"
)

var strictProviderPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
var providerInNamePattern = regexp.MustCompile(`(?i)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`)

type AdoptionOptions struct {
	ClaudeProjectsDir string
	CodexSessionsDir  string
}

type Adoption struct {
	Path         string   `json:"path"`
	Tool         string   `json:"tool"`
	Cwd          string   `json:"cwd"`
	ProviderUUID string   `json:"providerUuid"`
	Cmd          string   `json:"cmd"`
	Args         []string `json:"args"`
}

type AdoptResult struct {
	OK       bool     `json:"ok"`
	LaneID   string   `json:"laneId"`
	Adoption Adoption `json:"adoption"`
}

// ResolveAdoption turns one explicit path or provider UUID into a minimal
// create-with-resume request. It never guesses among multiple Claude matches
// and never returns an identity that cannot be bound to an on-disk source.
func ResolveAdoption(target string, options AdoptionOptions) (Adoption, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return Adoption{}, errors.New("adopt target is required")
	}
	if strings.HasPrefix(target, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return Adoption{}, err
		}
		target = filepath.Join(home, strings.TrimPrefix(target, "~/"))
	}
	if info, err := os.Stat(target); err == nil {
		if !info.Mode().IsRegular() {
			return Adoption{}, fmt.Errorf("adopt target is not a regular file: %s", target)
		}
		return adoptionFromPath(target)
	} else if strings.ContainsRune(target, filepath.Separator) || strings.HasSuffix(target, ".jsonl") {
		return Adoption{}, fmt.Errorf("adopt source does not exist: %s", target)
	}
	if !strictProviderPattern.MatchString(target) {
		return Adoption{}, fmt.Errorf("provider-unbound: %q is neither a conversation JSONL nor a provider UUID", target)
	}

	claude, claudeErr := findClaudeByUUID(target, options.ClaudeProjectsDir)
	codex, codexErr := findCodexByUUID(target, options.CodexSessionsDir)
	if claudeErr != nil {
		return Adoption{}, claudeErr
	}
	if codexErr != nil {
		return Adoption{}, codexErr
	}
	if claude.Path != "" && codex.Path != "" {
		return Adoption{}, fmt.Errorf("provider UUID %s is ambiguous across Claude and Codex stores; pass an explicit path", target)
	}
	if claude.Path != "" {
		return claude, nil
	}
	if codex.Path != "" {
		return codex, nil
	}
	return Adoption{}, fmt.Errorf("provider-unbound: no conversation source exists for %s", target)
}

func findClaudeByUUID(uuid, explicitRoot string) (Adoption, error) {
	root := explicitRoot
	if root == "" {
		var err error
		root, err = watch.ClaudeProjectsDir()
		if err != nil {
			return Adoption{}, err
		}
	}
	projects, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return Adoption{}, nil
	}
	if err != nil {
		return Adoption{}, fmt.Errorf("scan Claude projects: %w", err)
	}
	matches := make([]string, 0, 1)
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		resolution := watch.ResolveClaudeJSONL(filepath.Join(root, project.Name()), uuid)
		if resolution.Path != "" && filepath.Base(resolution.Path) == uuid+".jsonl" {
			matches = append(matches, resolution.Path)
		}
	}
	if len(matches) > 1 {
		sort.Strings(matches)
		return Adoption{}, fmt.Errorf("provider UUID %s matches multiple Claude projects; pass an explicit path", uuid)
	}
	if len(matches) == 0 {
		return Adoption{}, nil
	}
	return adoptionFromPath(matches[0])
}

func findCodexByUUID(uuid, root string) (Adoption, error) {
	resolution := watch.ResolveCodexRolloutPath(watch.CodexResolveOptions{
		Args: []string{"resume", uuid}, SessionsDir: root,
	})
	if resolution.Path == "" {
		return Adoption{}, nil
	}
	return adoptionFromPath(resolution.Path)
}

func adoptionFromPath(path string) (Adoption, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Adoption{}, err
	}
	provider, cwd, codex, err := readConversationIdentity(absolute)
	if err != nil {
		return Adoption{}, err
	}
	if provider == "" || !strictProviderPattern.MatchString(provider) {
		return Adoption{}, fmt.Errorf("provider-unbound: cannot resolve provider UUID from %s", absolute)
	}
	if cwd == "" {
		return Adoption{}, fmt.Errorf("provider-unbound: cannot resolve cwd from %s", absolute)
	}
	tool := string(state.ToolClaude)
	cmd := "claude"
	if codex {
		tool = string(state.ToolCodex)
		cmd = "codex"
	} else {
		resolution := watch.ResolveClaudeJSONL(filepath.Dir(absolute), provider)
		if resolution.Path == "" || filepath.Clean(resolution.Path) != filepath.Clean(absolute) {
			return Adoption{}, fmt.Errorf("provider-unbound: Claude resolver did not bind %s", absolute)
		}
	}
	argv := ledger.ResumeRecipeForProvider(tool, cmd, provider)
	if len(argv) == 0 {
		return Adoption{}, fmt.Errorf("provider-unbound: no safe resume recipe for %s", provider)
	}
	return Adoption{
		Path: absolute, Tool: tool, Cwd: cwd, ProviderUUID: provider,
		Cmd: argv[0], Args: append([]string(nil), argv[1:]...),
	}, nil
}

func readConversationIdentity(path string) (provider, cwd string, codex bool, err error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", false, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for lines := 0; lines < 256 && scanner.Scan(); lines++ {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		if value, ok := record["cwd"].(string); ok && cwd == "" {
			cwd = value
		}
		if record["type"] == "session_meta" {
			codex = true
			if payload, ok := record["payload"].(map[string]any); ok {
				if value, ok := payload["cwd"].(string); ok && cwd == "" {
					cwd = value
				}
				if value, ok := payload["id"].(string); ok {
					provider = value
				}
			}
		}
		if provider != "" && cwd != "" {
			break
		}
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return "", "", false, fmt.Errorf("read conversation %s: %w", path, scanErr)
	}
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if !codex && strings.HasPrefix(base, "rollout-") {
		codex = true
	}
	if provider == "" {
		if codex {
			matches := providerInNamePattern.FindAllString(base, -1)
			if len(matches) > 0 {
				provider = matches[len(matches)-1]
			}
		} else {
			provider = base
		}
	}
	if cwd == "" && !codex {
		cwd = strings.ReplaceAll(filepath.Base(filepath.Dir(path)), "-", "/")
		if cwd != "" && !strings.HasPrefix(cwd, "/") {
			cwd = "/" + cwd
		}
	}
	return provider, cwd, codex, nil
}

type AdoptOptions struct {
	Force bool
}

// Adopt creates through the normal manager boundary, then appends explicit
// actor=adopt facts. The normal created event remains the write-ahead record;
// the adopt-authored pair makes the user's explicit external adoption
// auditable without weakening that launch boundary.
func Adopt(
	ctx context.Context,
	adoption Adoption,
	name string,
	creator SessionCreator,
	boundaries ledger.BoundaryWriter,
	observations ledger.ObservationWriter,
	options ...AdoptOptions,
) (AdoptResult, error) {
	selected := AdoptOptions{}
	if len(options) > 0 {
		selected = options[0]
	}
	if adoption.ProviderUUID == "" || len(adoption.Args) == 0 {
		return AdoptResult{}, errors.New("provider-unbound: adoption has no safe provider resume recipe")
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(adoption.Cwd)
	}
	created, err := creator.Create(ctx, state.CreateSessionRequest{
		Cmd: adoption.Cmd, Args: append([]string(nil), adoption.Args...),
		Cwd: adoption.Cwd, Name: name, Force: selected.Force,
	})
	if err != nil {
		return AdoptResult{}, err
	}
	resumeArgv := append([]string{adoption.Cmd}, adoption.Args...)
	if boundaries != nil {
		err = boundaries.RecordCreated(ctx, ledger.Created{
			Meta: ledger.Meta{LaneID: created.ID, AtMS: time.Now().UnixMilli(), Actor: ledger.ActorAdopt},
			Name: name, Tool: adoption.Tool, Cwd: adoption.Cwd,
			ResumeArgv: resumeArgv, LaneUUID: created.ID, ProviderUUID: adoption.ProviderUUID,
			CreatorKind: ledger.CreatorUser, CreatorID: "uid:" + strconv.Itoa(os.Getuid()),
		})
		if err != nil {
			return AdoptResult{LaneID: created.ID, Adoption: adoption}, fmt.Errorf("adopted lane %s but created annotation failed: %w", created.ID, err)
		}
	}
	if observations != nil {
		err = observations.RecordProviderBound(ctx, ledger.ProviderBound{
			Meta:         ledger.Meta{LaneID: created.ID, Actor: ledger.ActorAdopt},
			ProviderUUID: adoption.ProviderUUID, ResumeArgv: resumeArgv,
		})
		if err != nil {
			return AdoptResult{LaneID: created.ID, Adoption: adoption}, fmt.Errorf("adopted lane %s but provider annotation failed: %w", created.ID, err)
		}
	}
	return AdoptResult{OK: true, LaneID: created.ID, Adoption: adoption}, nil
}
