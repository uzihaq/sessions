package state

import (
	"fmt"
	"html"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const launchdLabelPrefix = "tech.pretty-pty.runner."

type plistArgs struct {
	ID               string
	ProgramArguments []string
	Env              map[string]string
	Cwd              string
	LogPath          string
}

func plistPath(launchAgentsDir, id string) string {
	return filepath.Join(launchAgentsDir, launchdLabelPrefix+id+".plist")
}

func writePlist(launchAgentsDir string, args plistArgs) (string, error) {
	if len(args.ProgramArguments) == 0 {
		return "", fmt.Errorf("runner launcher returned no program arguments")
	}
	if err := os.MkdirAll(launchAgentsDir, 0o700); err != nil {
		return "", fmt.Errorf("create launch agents directory: %w", err)
	}
	path := plistPath(launchAgentsDir, args.ID)
	if err := os.WriteFile(path, []byte(plistXML(args)), 0o600); err != nil {
		return "", fmt.Errorf("write runner plist: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return "", fmt.Errorf("chmod runner plist: %w", err)
	}
	return path, nil
}

func plistXML(args plistArgs) string {
	escape := func(value string) string { return html.EscapeString(value) }
	program := make([]string, 0, len(args.ProgramArguments))
	for _, value := range args.ProgramArguments {
		program = append(program, "    <string>"+escape(value)+"</string>")
	}
	keys := make([]string, 0, len(args.Env))
	for key := range args.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	environment := make([]string, 0, len(keys)*2)
	for _, key := range keys {
		environment = append(environment,
			"    <key>"+escape(key)+"</key>",
			"    <string>"+escape(args.Env[key])+"</string>",
		)
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + launchdLabelPrefix + escape(args.ID) + `</string>
  <key>ProgramArguments</key>
  <array>
` + strings.Join(program, "\n") + `
  </array>
  <key>EnvironmentVariables</key>
  <dict>
` + strings.Join(environment, "\n") + `
  </dict>
  <key>WorkingDirectory</key>
  <string>` + escape(args.Cwd) + `</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>` + escape(args.LogPath) + `</string>
  <key>StandardErrorPath</key>
  <string>` + escape(args.LogPath) + `</string>
</dict>
</plist>
`
}
