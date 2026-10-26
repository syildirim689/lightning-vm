package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
)

// Terminal mode ("console terminal"): an administrator's browser terminal to the host. The container runs
// privileged in the host's PID namespace and enters PID 1's namespaces (nsenter), so the shell is the host's
// root shell. The browser presents a one-time cookie the API issued (system.terminal + two-factor); input is
// never logged, opening and closing are audited. Text frames carry {"type":"resize","cols","rows"}; binary
// frames carry keystrokes in and terminal output out.

const terminalCookie = "lvm_terminal"

var errIdle = errors.New("TERMINAL_IDLE")

// hostShell: bash when the host has it, sh otherwise. Overridable (TERMINAL_SHELL) for tests.
func hostShell() []string {
	if s := os.Getenv("TERMINAL_SHELL"); s != "" {
		return []string{"/bin/sh", "-c", s}
	}
	return []string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/sh", "-c", "cd /root 2>/dev/null; exec bash -l 2>/dev/null || exec sh -l"}
}

type resize struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

func (g *Gateway) serveTerminal(w http.ResponseWriter, r *http.Request) {
	if !g.originAllowed(r) {
		logger.Warn("terminal_origin_rejected")
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	client, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer client.CloseNow()
	client.SetReadLimit(64 << 10)
	ctx := r.Context()

	var s *Session
	if cookie, err := r.Cookie(terminalCookie); err == nil && len(cookie.Value) >= 32 {
		if s, err = g.store.Consume(ctx, sessionKey(cookie.Value)); err != nil {
			logger.Error("terminal_store_failed", "error", err.Error())
		}
	}
	if s == nil {
		g.store.Event(ctx, map[string]any{"event": "terminal_denied", "reason": "TERMINAL_SESSION_INVALID"})
		client.Close(closeSession, "TERMINAL_SESSION_INVALID")
		return
	}
	if user, total := g.countFor(s.UserID); user >= g.maxPerUser || total >= g.maxTotal {
		g.store.Event(ctx, map[string]any{"event": "terminal_denied", "reason": "TERMINAL_LIMIT", "userId": s.UserID})
		client.Close(closeTooMany, "TERMINAL_LIMIT")
		return
	}

	argv := hostShell()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = []string{"TERM=xterm-256color", "LANG=C.UTF-8", "HOME=/root", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 100, Rows: 30})
	if err != nil {
		logger.Error("terminal_start_failed", "error", err.Error())
		g.store.Event(ctx, map[string]any{"event": "terminal_failed", "reason": "TERMINAL_START_FAILED", "userId": s.UserID})
		client.Close(closeUpstream, "TERMINAL_START_FAILED")
		return
	}
	defer func() { _ = f.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	runCtx, cancel := context.WithCancelCause(ctx)
	runCtx, stop := context.WithTimeoutCause(runCtx, g.maxDuration, errors.New("TERMINAL_EXPIRED"))
	defer stop()
	c := &conn{s: s, cancel: cancel}
	g.mu.Lock()
	g.active[c] = struct{}{}
	g.mu.Unlock()
	started := time.Now()
	_ = g.store.Active(ctx, s, started)
	g.store.Event(ctx, map[string]any{"event": "terminal_opened", "userId": s.UserID})
	logger.Info("terminal_opened")

	var lastInput atomic.Int64
	lastInput.Store(time.Now().UnixNano())
	done := make(chan struct{}, 2)
	go func() { // shell -> browser
		buf := make([]byte, 32<<10)
		for {
			n, err := f.Read(buf)
			if n > 0 && client.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
				break
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}()
	go func() { // browser -> shell
		for {
			typ, data, err := client.Read(ctx)
			if err != nil {
				break
			}
			if typ == websocket.MessageText {
				var m resize
				if json.Unmarshal(data, &m) == nil && m.Type == "resize" && m.Cols > 0 && m.Rows > 0 && m.Cols < 1000 && m.Rows < 1000 {
					_ = pty.Setsize(f, &pty.Winsize{Cols: m.Cols, Rows: m.Rows})
				}
				continue
			}
			lastInput.Store(time.Now().UnixNano())
			if _, err := f.Write(data); err != nil {
				break
			}
		}
		done <- struct{}{}
	}()
	idle := time.NewTicker(15 * time.Second)
	defer idle.Stop()
wait:
	for {
		select {
		case <-done:
			break wait
		case <-runCtx.Done():
			break wait
		case <-idle.C:
			if time.Since(time.Unix(0, lastInput.Load())) > g.idle {
				cancel(errIdle)
			}
		}
	}

	reason := "TERMINAL_CLOSED"
	switch cause := context.Cause(runCtx); {
	case errors.Is(cause, errRevoked):
		reason = "TERMINAL_REVOKED"
		client.Close(closeRevoked, reason)
	case errors.Is(cause, errIdle):
		reason = "TERMINAL_IDLE"
		client.Close(closeExpired, reason)
	case cause != nil && cause.Error() == "TERMINAL_EXPIRED":
		reason = "TERMINAL_EXPIRED"
		client.Close(closeExpired, reason)
	default:
		client.Close(websocket.StatusNormalClosure, reason)
	}
	g.mu.Lock()
	delete(g.active, c)
	g.mu.Unlock()
	_ = g.store.Inactive(context.WithoutCancel(ctx), s)
	g.store.Event(context.WithoutCancel(ctx), map[string]any{"event": "terminal_closed", "reason": reason, "userId": s.UserID, "durationMs": time.Since(started).Milliseconds()})
	logger.Info("terminal_closed", "reason", reason)
}
