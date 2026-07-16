package ledger

import (
	"path/filepath"
	"regexp"
	"strings"
)

var providerIDPattern = regexp.MustCompile(`(?i)^[0-9a-f-]{8,}$`)

// SafeResumeRecipe follows the normative TypeScript argument forms while
// intentionally discarding every unrelated argument. The result can contain
// a provider identity and mode switch, but never a prompt, environment value,
// or arbitrary positional argument.
func SafeResumeRecipe(tool, cmd string, args []string) (providerUUID string, argv []string) {
	base := strings.ToLower(filepath.Base(cmd))
	if tool == "claude-code" || base == "claude" {
		for index := 0; index+1 < len(args); index++ {
			if args[index] != "--session-id" && args[index] != "--resume" {
				continue
			}
			if providerIDPattern.MatchString(args[index+1]) {
				providerUUID = args[index+1]
				return providerUUID, []string{cmd, "--resume", providerUUID}
			}
		}
		return "", nil
	}
	if tool == "codex" || base == "codex" {
		for index, argument := range args {
			if argument == "resume" || argument == "--resume" {
				if index+1 < len(args) && providerIDPattern.MatchString(args[index+1]) {
					providerUUID = args[index+1]
					return providerUUID, []string{cmd, "resume", providerUUID}
				}
			}
			if strings.HasPrefix(argument, "--resume=") {
				candidate := strings.TrimPrefix(argument, "--resume=")
				if providerIDPattern.MatchString(candidate) {
					return candidate, []string{cmd, "resume", candidate}
				}
			}
		}
	}
	return "", nil
}

// ResumeRecipeForProvider builds the minimal recipe used after a provider is
// bound asynchronously (notably a fresh Codex rollout).
func ResumeRecipeForProvider(tool, cmd, providerUUID string) []string {
	if !providerIDPattern.MatchString(providerUUID) {
		return nil
	}
	base := strings.ToLower(filepath.Base(cmd))
	switch {
	case tool == "claude-code" || base == "claude":
		return []string{cmd, "--resume", providerUUID}
	case tool == "codex" || base == "codex":
		return []string{cmd, "resume", providerUUID}
	default:
		return nil
	}
}
