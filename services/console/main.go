// Lightning VM console gateway: relays the browser's WebSocket (wss://panel/console/ws) to a VM's
// WebMKS endpoint on the private management network. The browser presents only a one-time cookie;
// the VMware ticket stays server-side.
package main

import (
	"cmp"
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "console", "env", cmp.Or(os.Getenv("APP_ENV"), "production"))

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		res, err := http.Get("http://127.0.0.1:8080/healthz")
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}
	db, _ := strconv.Atoi(os.Getenv("REDIS_DB"))
	rdb := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "redis:6379"), Password: os.Getenv("REDIS_PASSWORD"), DB: db})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	// "console terminal": the host terminal for administrators (terminal.go); otherwise the VM console gateway.
	ns := "console"
	if len(os.Args) > 1 && os.Args[1] == "terminal" {
		ns = "terminal"
	}
	// A restarted gateway has no live sessions; drop entries a previous process could not remove.
	_ = rdb.Del(ctx, ns+":active").Err()

	origins := map[string]bool{}
	for _, o := range strings.Split(os.Getenv("CONSOLE_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins[o] = true
		}
	}
	g := &Gateway{store: &redisStore{rdb: rdb, ns: ns}, guard: newNetGuard(), allowedOrigins: origins, active: map[*conn]struct{}{},
		maxPerUser: envInt("CONSOLE_MAX_PER_USER", 3), maxTotal: envInt("CONSOLE_MAX_TOTAL", 100),
		maxDuration: time.Duration(envInt("CONSOLE_MAX_MINUTES", 60)) * time.Minute, idle: time.Duration(envInt("TERMINAL_IDLE_MINUTES", 15)) * time.Minute}
	if ns == "terminal" {
		g.maxPerUser, g.maxTotal = envInt("TERMINAL_MAX_PER_USER", 1), envInt("TERMINAL_MAX_TOTAL", 3)
	}
	go g.revocationLoop(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if rdb.Ping(r.Context()).Err() != nil {
			http.Error(w, "redis unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	if ns == "terminal" {
		mux.HandleFunc("GET /terminal/ws", g.serveTerminal)
	} else {
		mux.Handle("GET /console/ws", g)
	}
	srv := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		g.revoke(Revocation{All: true}) // hijacked WebSockets are not closed by Shutdown
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	logger.Info("started", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("listen_failed", "error", err.Error())
		os.Exit(1)
	}
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
