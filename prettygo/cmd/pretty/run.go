package main

import (
	"os"
	"path/filepath"
	"strings"
)

type runLaneRequest struct {
	Cmd      string   `json:"cmd"`
	Args     []string `json:"args"`
	Cwd      string   `json:"cwd"`
	Name     string   `json:"name,omitempty"`
	Kind     string   `json:"kind"`
	SpecPath string   `json:"specPath,omitempty"`
}

func (a *app) cmdRun(args []string) error {
	separator := -1
	for index, argument := range args {
		if argument == "--" {
			separator = index
			break
		}
	}
	if separator < 0 || separator+1 >= len(args) || args[separator+1] == "" {
		return fail(1, "usage: pretty run [--name N] [--cwd D] [--spec FILE] -- <cmd args...>")
	}
	options := append([]string(nil), args[:separator]...)
	command := append([]string(nil), args[separator+1:]...)
	name, hasName := pluck(&options, "--name")
	if hasName && strings.TrimSpace(name) == "" {
		return fail(1, "--name needs a non-empty label")
	}
	cwd, hasCwd := pluck(&options, "--cwd")
	if hasCwd && strings.TrimSpace(cwd) == "" {
		return fail(1, "--cwd needs a directory")
	}
	specPath, hasSpec := pluck(&options, "--spec")
	if hasSpec && strings.TrimSpace(specPath) == "" {
		return fail(1, "--spec needs a file path")
	}
	if len(options) != 0 {
		return fail(1, "unknown run option %s", options[0])
	}
	var err error
	if cwd == "" {
		cwd, err = os.Getwd()
	} else {
		cwd, err = filepath.Abs(cwd)
	}
	if err != nil {
		return fail(1, "resolve cwd: %s", err)
	}
	if info, statErr := os.Stat(cwd); statErr != nil || !info.IsDir() {
		return fail(1, "cwd is not a directory: %s", cwd)
	}
	if specPath != "" {
		if !filepath.IsAbs(specPath) {
			specPath = filepath.Join(cwd, specPath)
		}
		specPath, err = filepath.Abs(specPath)
		if err != nil {
			return fail(1, "resolve spec path: %s", err)
		}
		if info, statErr := os.Stat(specPath); statErr != nil || info.IsDir() {
			return fail(1, "spec is not a file: %s", specPath)
		}
	}
	body := runLaneRequest{
		Cmd: command[0], Args: command[1:], Cwd: cwd, Name: strings.TrimSpace(name),
		Kind: "lane", SpecPath: specPath,
	}
	var created map[string]any
	if err := a.postJSON("/api/lanes", body, &created, 2); err != nil {
		return err
	}
	if a.wantJSON {
		return writeJSON(a.stdout, created, true)
	}
	id, ok := created["id"].(string)
	if !ok || id == "" {
		return fail(2, "lane create response did not include an id")
	}
	_, err = a.stdout.Write([]byte(id + "\n"))
	return err
}
