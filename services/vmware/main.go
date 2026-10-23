// Lightning VM VMware adapter: a small internal HTTP service around govmomi.
// Only the API calls it (shared bearer token, internal Docker network). It keeps no state and
// never logs request bodies, so VMware credentials pass through memory only.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "vmware")

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func failureStatus(code string) int {
	switch code {
	case "INVALID_LOGIN", "PERMISSION_DENIED":
		return http.StatusUnauthorized
	case "INVALID_CA", "INVALID_PIN", "INVALID_TLS_MODE", "INVALID_REQUEST", "ENDPOINT_BLOCKED":
		return http.StatusBadRequest
	}
	return http.StatusBadGateway
}

func handler(token string, guard *netGuard) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("POST /v1/discover", func(w http.ResponseWriter, r *http.Request) {
		var req Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || req.Host == "" || req.Username == "" {
			writeJSON(w, 400, Failure{Code: "INVALID_REQUEST", Message: "host and username are required"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		start := time.Now()
		res, err := discover(ctx, guard, req)
		if err != nil {
			f := classify(err)
			logger.Warn("discover_failed", "code", f.Code, "duration_ms", time.Since(start).Milliseconds())
			writeJSON(w, failureStatus(f.Code), f)
			return
		}
		logger.Info("discover_succeeded", "kind", res.Product.Kind, "hosts", len(res.Hosts), "vms", len(res.VMs), "duration_ms", time.Since(start).Milliseconds())
		writeJSON(w, 200, res)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				writeJSON(w, 401, Failure{Code: "UNAUTHORIZED", Message: "service token required"})
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func main() {
	// The image has no shell or curl; Compose's healthcheck runs the binary itself.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		res, err := http.Get("http://127.0.0.1:8080/healthz")
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}
	raw, err := os.ReadFile(os.Getenv("VMWARE_SERVICE_TOKEN_FILE"))
	token := strings.TrimSpace(string(raw))
	if err != nil || len(token) < 32 {
		logger.Error("service_token_missing")
		os.Exit(1)
	}
	srv := &http.Server{Addr: ":8080", Handler: handler(token, newNetGuard()), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	logger.Info("started", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("listen_failed", "error", err.Error())
		os.Exit(1)
	}
}
