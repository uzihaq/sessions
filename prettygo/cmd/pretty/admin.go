package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type plistEnvironment struct {
	Key   string
	Value string
}

type daemonPlistOptions struct {
	Label      string
	Program    string
	WorkingDir string
	LogFile    string
	Env        []plistEnvironment
}

func daemonPlist(options daemonPlistOptions) string {
	var environment strings.Builder
	for _, entry := range options.Env {
		fmt.Fprintf(&environment, "    <key>%s</key>\n    <string>%s</string>\n", escapeXML(entry.Key), escapeXML(entry.Value))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
%s  </dict>
  <key>WorkingDirectory</key>
  <string>%s</string>
  <key>RunAtLoad</key>
  <true/>
  <!-- KeepAlive=true: the daemon itself should restart on crash. This is
       distinct from the per-session runner plists, which use KeepAlive only
       on non-zero exit (SuccessfulExit=false). -->
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`, escapeXML(options.Label), escapeXML(options.Program), environment.String(),
		escapeXML(options.WorkingDir), escapeXML(options.LogFile), escapeXML(options.LogFile))
}

func escapeXML(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	return strings.ReplaceAll(value, ">", "&gt;")
}

func (a *app) cmdInstall(_ []string) error {
	if runtime.GOOS != "darwin" {
		return fail(2, "install requires macOS launchd")
	}
	daemonPath := os.Getenv("PRETTYD_BINARY")
	if daemonPath == "" {
		if executable, err := os.Executable(); err == nil {
			candidate := filepath.Join(filepath.Dir(executable), "prettyd")
			if executableFile(candidate) {
				daemonPath = candidate
			}
		}
	}
	if daemonPath == "" {
		daemonPath, _ = exec.LookPath("prettyd")
	}
	if daemonPath == "" || !executableFile(daemonPath) {
		return fail(2, "install is incomplete: missing Go daemon binary 'prettyd' beside pretty or on PATH; reinstall pretty-pty")
	}
	daemonPath, _ = filepath.Abs(daemonPath)
	launchctl := ""
	for _, candidate := range []string{"/bin/launchctl", "/usr/bin/launchctl"} {
		if executableFile(candidate) {
			launchctl = candidate
			break
		}
	}
	if launchctl == "" {
		return fail(2, "install requires launchctl, but it was not found in /bin or /usr/bin")
	}
	const daemonPATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
	logDir := filepath.Join(a.home, "Library", "Logs", "pretty-pty")
	logFile := filepath.Join(logDir, "daemon.log")
	agentsDir := filepath.Join(a.home, "Library", "LaunchAgents")
	const label = "tech.pretty-pty.daemon"
	plistPath := filepath.Join(agentsDir, label+".plist")
	environment := []plistEnvironment{{Key: "PATH", Value: daemonPATH}}
	for _, key := range []string{"PRETTYD_HOST", "PRETTYD_PORT", "PRETTYD_WEB_DIR", "PRETTYD_RUNNER"} {
		if value := os.Getenv(key); value != "" {
			environment = append(environment, plistEnvironment{Key: key, Value: value})
		}
	}
	if err := os.MkdirAll(agentsDir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return err
	}
	xml := daemonPlist(daemonPlistOptions{
		Label: label, Program: daemonPath, WorkingDir: filepath.Dir(daemonPath), LogFile: logFile, Env: environment,
	})
	if err := os.WriteFile(plistPath, []byte(xml), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(plistPath, 0o600)
	fmt.Fprintf(a.stdout, "wrote plist: %s\n", plistPath)
	uid := os.Getuid()
	domain := fmt.Sprintf("gui/%d", uid)
	serviceTarget := domain + "/" + label
	command := exec.Command(launchctl, "bootstrap", domain, plistPath)
	output, err := command.CombinedOutput()
	if err != nil {
		alreadyLoaded := false
		if exitError, ok := err.(*exec.ExitError); ok && exitError.ExitCode() == 17 {
			alreadyLoaded = true
		}
		if regexpAlreadyLoaded.Match(output) {
			alreadyLoaded = true
		}
		if !alreadyLoaded {
			return fail(2, "launchctl bootstrap failed (status=%s): %s", commandStatus(err), outputOrError(output, err))
		}
		kick := exec.Command(launchctl, "kickstart", "-k", serviceTarget)
		kickOutput, kickErr := kick.CombinedOutput()
		if kickErr != nil {
			return fail(2, "launchctl kickstart failed (status=%s): %s", commandStatus(kickErr), outputOrError(kickOutput, kickErr))
		}
	}
	deadline := a.now().Add(15 * time.Second)
	lastHealthError := "no response"
	for a.now().Before(deadline) {
		response, requestErr := a.api.request(context.Background(), "GET", "/api/health", nil, time.Second)
		if requestErr == nil && response.status == 200 {
			lastHealthError = ""
			break
		}
		if requestErr != nil {
			lastHealthError = requestErr.Error()
		} else {
			lastHealthError = fmt.Sprintf("HTTP %d", response.status)
		}
		a.sleep(250 * time.Millisecond)
	}
	daemonHost := getenv("PRETTYD_HOST", "127.0.0.1")
	daemonPort := getenv("PRETTYD_PORT", "8787")
	if lastHealthError != "" {
		return fail(2, "daemon did not become healthy at http://%s:%s/api/health within 15s (%s); see %s", daemonHost, daemonPort, lastHealthError, logFile)
	}
	token := a.api.readToken()
	io.WriteString(a.stdout, "\nprettyd daemon registered, started, and healthy.\n")
	fmt.Fprintf(a.stdout, "  URL:   http://%s:%s\n", daemonHost, daemonPort)
	if token != "" {
		fmt.Fprintf(a.stdout, "  Token: %s\n", token)
		io.WriteString(a.stdout, "\nPaste the URL and token into the pretty-PTY web UI (server settings).\n")
	} else {
		io.WriteString(a.stdout, "\nToken not yet generated — give the daemon a moment, then run: pretty token\n")
	}
	fmt.Fprintf(a.stdout, "  Logs:  %s\n", logFile)
	return nil
}

var regexpAlreadyLoaded = regexp.MustCompile(`(?i)already (loaded|bootstrapped)`)

func commandStatus(err error) string {
	if exitError, ok := err.(*exec.ExitError); ok {
		return strconv.Itoa(exitError.ExitCode())
	}
	return "unknown"
}

func outputOrError(output []byte, err error) string {
	if text := strings.TrimSpace(string(output)); text != "" {
		return text
	}
	if err != nil {
		return err.Error()
	}
	return "unknown error"
}

type deployOptions struct {
	repoOverride string
	noPull       bool
	dryRun       bool
}

func parseDeployOptions(args []string) (deployOptions, error) {
	var options deployOptions
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--repo":
			if options.repoOverride != "" || index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
				return options, fail(1, "usage: pretty deploy [--repo <dir>] [--no-pull] [--dry-run]")
			}
			index++
			options.repoOverride = args[index]
		case "--no-pull":
			if options.noPull {
				return options, fail(1, "--no-pull may only be specified once")
			}
			options.noPull = true
		case "--dry-run":
			if options.dryRun {
				return options, fail(1, "--dry-run may only be specified once")
			}
			options.dryRun = true
		default:
			return options, fail(1, "unknown deploy option: %s\nusage: pretty deploy [--repo <dir>] [--no-pull] [--dry-run]", args[index])
		}
	}
	return options, nil
}

func (a *app) cmdDeploy(args []string) error {
	options, err := parseDeployOptions(args)
	if err != nil {
		return err
	}
	start := options.repoOverride
	if start == "" {
		start, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	repo, err := findGitRoot(start)
	if err != nil {
		return err
	}
	prettydDir := filepath.Join(repo, "prettyd")
	frontendDir := filepath.Join(repo, "frontend")
	serverJS := filepath.Join(prettydDir, "dist", "server.js")
	for _, required := range []string{filepath.Join(prettydDir, "package.json"), filepath.Join(frontendDir, "package.json")} {
		if _, statErr := os.Stat(required); statErr != nil {
			return fail(1, "deploy repo is incomplete: missing %s", required)
		}
	}
	conflict := exec.Command("git", "diff", "--name-only", "--diff-filter=U")
	conflict.Dir = repo
	conflictOutput, conflictErr := conflict.CombinedOutput()
	if conflictErr != nil {
		return a.deployAbort("conflict check", outputOrError(conflictOutput, conflictErr))
	}
	if text := strings.TrimSpace(string(conflictOutput)); text != "" {
		return a.deployAbort("conflict check", "working tree has unresolved conflicts:\n"+text)
	}
	serviceTarget := fmt.Sprintf("gui/%d/tech.pretty-pty.daemon", os.Getuid())
	nodeBinary, lookupErr := exec.LookPath("node")
	if lookupErr != nil {
		return a.deployAbort("dist/server.js import preflight", lookupErr.Error())
	}
	serverURL := (&url.URL{Scheme: "file", Path: serverJS}).String()
	smokeArgs := []string{"--input-type=module", "-e", fmt.Sprintf("await import(%q)", serverURL)}
	runPreflight := func() error {
		encoded, readErr := os.ReadFile(serverJS)
		if readErr != nil {
			return a.deployAbort("dist/server.js import preflight", fmt.Sprintf("cannot read %s: %s", serverJS, readErr))
		}
		if !bytes.Contains(encoded, []byte("PRETTYD_SMOKE")) {
			return a.deployAbort("dist/server.js import preflight", fmt.Sprintf("%s is stale and lacks the PRETTYD_SMOKE guard; run a live deploy to rebuild it safely", serverJS))
		}
		environment := append(os.Environ(), "PRETTYD_SMOKE=1")
		if err := a.runDeployStep("dist/server.js import preflight", nodeBinary, smokeArgs, prettydDir, environment, "PRETTYD_SMOKE=1", 5*time.Second); err != nil {
			return err
		}
		io.WriteString(a.stdout, "  PASS: dist/server.js imports resolved within 5s\n")
		return nil
	}
	fmt.Fprintf(a.stdout, "pretty deploy\nrepo: %s\nmode: %s\n\n", repo, map[bool]string{true: "dry-run", false: "live"}[options.dryRun])
	if options.dryRun {
		pullLabel := "SKIP (--dry-run)"
		if options.noPull {
			pullLabel = "SKIP (--no-pull)"
		}
		plan := []string{
			fmt.Sprintf("%s  %s", pullLabel, deployCommandText("git", []string{"pull", "--ff-only"}, repo, "")),
			"SKIP (--dry-run)  " + deployCommandText("npm", []string{"install"}, prettydDir, ""),
			"SKIP (--dry-run)  " + deployCommandText("npm", []string{"install"}, frontendDir, ""),
			"SKIP (--dry-run)  " + deployCommandText("npm", []string{"run", "build"}, prettydDir, ""),
			"SKIP (--dry-run)  " + deployCommandText("npm", []string{"run", "build"}, frontendDir, ""),
			"RUN                " + deployCommandText(nodeBinary, smokeArgs, prettydDir, "PRETTYD_SMOKE=1"),
			"SKIP (--dry-run)  pgrep -f dist/runner.js | wc -l  # runner baseline",
			fmt.Sprintf("SKIP (--dry-run)  launchctl kickstart -k %s", serviceTarget),
			fmt.Sprintf("SKIP (--dry-run)  poll %s:%s/api/health for up to 30s", a.host, a.port),
			"SKIP (--dry-run)  verify runner count >= baseline - 1",
		}
		io.WriteString(a.stdout, "Plan:\n")
		for index, line := range plan {
			fmt.Fprintf(a.stdout, "  %d. %s\n", index+1, line)
		}
		io.WriteString(a.stdout, "\nExecuting the import preflight (the only dry-run action):\n")
		if err := runPreflight(); err != nil {
			return err
		}
		io.WriteString(a.stdout, "\nPASS: dry-run preflight succeeded; no deploy actions were executed\n")
		return nil
	}
	if options.noPull {
		io.WriteString(a.stdout, "[1/10] SKIP git pull --ff-only (--no-pull)\n")
	} else {
		io.WriteString(a.stdout, "[1/10] Pull latest changes (fast-forward only)\n")
		if err := a.runDeployStep("git pull", "git", []string{"pull", "--ff-only"}, repo, nil, "", 0); err != nil {
			return err
		}
	}
	steps := []struct {
		heading, name, command, dir string
		args                        []string
	}{
		{"[2/10] Install prettyd dependencies (always)", "prettyd dependency install", "npm", prettydDir, []string{"install"}},
		{"[3/10] Install frontend dependencies (always)", "frontend dependency install", "npm", frontendDir, []string{"install"}},
		{"[4/10] Build prettyd", "prettyd build", "npm", prettydDir, []string{"run", "build"}},
		{"[5/10] Build frontend (TypeScript + Vite)", "frontend build", "npm", frontendDir, []string{"run", "build"}},
	}
	for _, step := range steps {
		fmt.Fprintln(a.stdout, step.heading)
		if err := a.runDeployStep(step.name, step.command, step.args, step.dir, nil, "", 0); err != nil {
			return err
		}
	}
	io.WriteString(a.stdout, "[6/10] Preflight dist/server.js imports\n")
	if err := runPreflight(); err != nil {
		return err
	}
	io.WriteString(a.stdout, "[7/10] Record runner baseline\n")
	baseline, err := a.runnerCount("runner baseline")
	if err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "  runner baseline: %d\n", baseline)
	io.WriteString(a.stdout, "[8/10] Restart prettyd LaunchAgent\n")
	if err := a.runDeployStep("launchd restart", "launchctl", []string{"kickstart", "-k", serviceTarget}, "", nil, "", 0); err != nil {
		return err
	}
	io.WriteString(a.stdout, "[9/10] Poll /api/health (up to 30s)\n")
	listenHost, listenPort, err := a.pollDeployHealth()
	if err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "  healthy: %s:%d\n", listenHost, listenPort)
	io.WriteString(a.stdout, "[10/10] Verify runner survival\n")
	after, err := a.runnerCount("runner survival check")
	if err != nil {
		return err
	}
	minimum := baseline - 1
	if after < minimum {
		return a.deployAbort("runner survival check", fmt.Sprintf("runner count %d is below required minimum %d (baseline %d)", after, minimum, baseline))
	}
	fmt.Fprintf(a.stdout, "  runners: %d (baseline %d, required >= %d)\n", after, baseline, minimum)
	io.WriteString(a.stdout, "\nPASS: deploy completed; dependencies installed, builds preflighted, daemon healthy\n")
	return nil
}

func findGitRoot(start string) (string, error) {
	resolved, err := filepath.Abs(start)
	if err != nil {
		return "", fail(1, "cannot resolve deploy repo '%s': %s", start, err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fail(1, "cannot inspect deploy repo '%s': %s", resolved, err)
	}
	if !info.IsDir() {
		return "", fail(1, "deploy repo is not a directory: %s", resolved)
	}
	for {
		if _, err := os.Stat(filepath.Join(resolved, ".git")); err == nil {
			return resolved, nil
		}
		parent := filepath.Dir(resolved)
		if parent == resolved {
			break
		}
		resolved = parent
	}
	return "", fail(1, "no git root found above %s", start)
}

func (a *app) deployAbort(step, message string) error {
	fmt.Fprintf(a.stderr, "\nFAIL: deploy aborted during %s\n", step)
	return fail(2, "%s", message)
}

func (a *app) runDeployStep(step, command string, args []string, dir string, environment []string, environmentPrefix string, timeout time.Duration) error {
	fmt.Fprintf(a.stdout, "  $ %s\n", deployCommandText(command, args, dir, environmentPrefix))
	ctx := context.Background()
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	process := exec.CommandContext(ctx, command, args...)
	process.Dir = dir
	if environment != nil {
		process.Env = environment
	}
	process.Stdin = a.stdin
	process.Stdout = a.stdout
	process.Stderr = a.stderr
	if err := process.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return a.deployAbort(step, fmt.Sprintf("command timed out after %dms", timeout.Milliseconds()))
		}
		return a.deployAbort(step, fmt.Sprintf("%s exited with status %s", command, commandStatus(err)))
	}
	return nil
}

func deployCommandText(command string, args []string, dir, environmentPrefix string) string {
	parts := append([]string{command}, args...)
	for index := range parts {
		parts[index] = shellQuote(parts[index])
	}
	rendered := strings.Join(parts, " ")
	if environmentPrefix != "" {
		rendered = environmentPrefix + " " + rendered
	}
	if dir != "" {
		return fmt.Sprintf("(cd %s && %s)", shellQuote(dir), rendered)
	}
	return rendered
}

func shellQuote(value string) string {
	if value != "" && shellSafe(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func shellSafe(value string) bool {
	for _, char := range value {
		if !(char >= 'A' && char <= 'Z') && !(char >= 'a' && char <= 'z') && !(char >= '0' && char <= '9') && !strings.ContainsRune("_./:@%+=,-", char) {
			return false
		}
	}
	return true
}

func (a *app) runnerCount(step string) (int, error) {
	io.WriteString(a.stdout, "  $ pgrep -f dist/runner.js | wc -l\n")
	command := exec.Command("pgrep", "-f", "dist/runner.js")
	output, err := command.Output()
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 1 {
			return 0, a.deployAbort(step, outputOrError(output, err))
		}
	}
	lines := strings.Fields(string(output))
	return len(lines), nil
}

func (a *app) pollDeployHealth() (string, int, error) {
	deadline := a.now().Add(30 * time.Second)
	lastError := "no response"
	for a.now().Before(deadline) {
		response, err := a.api.request(context.Background(), "GET", "/api/health", nil, 1500*time.Millisecond)
		if err == nil && response.status == 200 {
			var health struct {
				OK     bool   `json:"ok"`
				Name   string `json:"name"`
				Listen struct {
					Host string `json:"host"`
					Port int    `json:"port"`
				} `json:"listen"`
			}
			if unmarshalErr := jsonUnmarshal(response.body, &health); unmarshalErr == nil && health.OK && health.Name == "prettyd" {
				host := health.Listen.Host
				if host == "" {
					host = a.host
				}
				port, _ := strconv.Atoi(a.port)
				if health.Listen.Port != 0 {
					port = health.Listen.Port
				}
				return host, port, nil
			}
			lastError = "response did not report prettyd ok=true"
		} else if err != nil {
			lastError = err.Error()
		} else {
			lastError = fmt.Sprintf("HTTP %d", response.status)
		}
		a.sleep(500 * time.Millisecond)
	}
	return "", 0, a.deployAbort("health check", fmt.Sprintf("daemon did not become healthy within 30s (%s)", lastError))
}

func jsonUnmarshal(value []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(value))
	return decoder.Decode(target)
}
