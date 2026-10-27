// Lightning VM VMware adapter: a small internal HTTP service around govmomi.
// Only the API calls it (shared bearer token, internal Docker network). It keeps no state and
// never logs request bodies, so VMware credentials pass through memory only.
package main

import (
	"cmp"
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

	"github.com/vmware/govmomi/vim25"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "vmware", "env", cmp.Or(os.Getenv("APP_ENV"), "production"))

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func failureStatus(code string) int {
	switch code {
	case "VM_NOT_FOUND", "DATASTORE_NOT_FOUND":
		return http.StatusNotFound
	case "VM_POWERED_OFF", "TOOLS_NOT_RUNNING", "NOT_MANAGED", "NO_CDROM_CONTROLLER", "NOT_IMPORTABLE", "DISK_HAS_SNAPSHOTS", "DISK_SHRINK_NOT_SUPPORTED", "INVALID_STATE", "VM_HAS_NO_DISK", "DISK_NOT_SUPPORTED", "SYSTEM_DISK", "NO_DISK_CONTROLLER":
		return http.StatusConflict
	case "INVALID_LOGIN", "PERMISSION_DENIED":
		return http.StatusUnauthorized
	case "INVALID_CA", "INVALID_PIN", "INVALID_TLS_MODE", "INVALID_REQUEST", "ENDPOINT_BLOCKED", "PROVISIONING_NOT_SUPPORTED", "TEMPLATE_NOT_FOUND", "NETWORK_NOT_FOUND", "TEMPLATE_HAS_NO_NIC", "DISK_SMALLER_THAN_TEMPLATE":
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
	mux.HandleFunc("POST /v1/console-ticket", func(w http.ResponseWriter, r *http.Request) {
		var req TicketRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || req.Host == "" || req.Username == "" {
			writeJSON(w, 400, Failure{Code: "INVALID_REQUEST", Message: "host, username and vm are required"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		t, err := consoleTicket(ctx, guard, req)
		if err != nil {
			f := classify(err)
			logger.Warn("console_ticket_failed", "code", f.Code)
			writeJSON(w, failureStatus(f.Code), f)
			return
		}
		logger.Info("console_ticket_issued", "endpoint", t.Endpoint) // never the ticket or its URL
		writeJSON(w, 200, t)
	})
	// Provisioning endpoints share decode -> call -> classified error handling; bodies are never logged.
	handle := func(path string, timeout time.Duration, newReq func() any, call func(context.Context, any) (any, error)) {
		mux.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
			req := newReq()
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(req); err != nil {
				writeJSON(w, 400, Failure{Code: "INVALID_REQUEST", Message: "invalid JSON"})
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()
			out, err := call(ctx, req)
			if err != nil {
				f := classify(err)
				logger.Warn("vm_call_failed", "path", path, "code", f.Code)
				writeJSON(w, failureStatus(f.Code), f)
				return
			}
			writeJSON(w, 200, out)
		})
	}
	newVM := func() any { return &VMRequest{} }
	handle("/v1/vm/clone", 60*time.Second, func() any { return &CloneRequest{} }, func(ctx context.Context, r any) (any, error) { return cloneVM(ctx, guard, *r.(*CloneRequest)) })
	handle("/v1/vm/find", 30*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) {
			vm, err := findVM(ctx, c, q.Name)
			return map[string]any{"vm": vm}, err
		})
	})
	handle("/v1/task", 30*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return taskState(ctx, c, q.Task) })
	})
	handle("/v1/vm/power", 60*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return powerAction(ctx, c, *q) })
	})
	handle("/v1/vm/destroy", 120*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return destroyVM(ctx, c, *q) })
	})
	handle("/v1/vm/resize", 60*time.Second, func() any { return &ResizeRequest{} }, func(ctx context.Context, r any) (any, error) {
		q := r.(*ResizeRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return resizeVM(ctx, c, *q) })
	})
	newCopy := func() any { return &DiskCopyRequest{} }
	handle("/v1/vm/disk-copy", 60*time.Second, newCopy, func(ctx context.Context, r any) (any, error) {
		q := r.(*DiskCopyRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return copyDisk(ctx, c, *q) })
	})
	handle("/v1/backup/delete", 120*time.Second, newCopy, func(ctx context.Context, r any) (any, error) {
		q := r.(*DiskCopyRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return deleteBackup(ctx, c, *q) })
	})
	newDisk := func() any { return &DiskRequest{} }
	handle("/v1/vm/disks", 30*time.Second, newDisk, func(ctx context.Context, r any) (any, error) {
		q := r.(*DiskRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return listDisks(ctx, c, *q) })
	})
	handle("/v1/vm/disk-add", 60*time.Second, newDisk, func(ctx context.Context, r any) (any, error) {
		q := r.(*DiskRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return addDisk(ctx, c, *q) })
	})
	handle("/v1/vm/disk-remove", 60*time.Second, newDisk, func(ctx context.Context, r any) (any, error) {
		q := r.(*DiskRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return removeDisk(ctx, c, *q) })
	})
	handle("/v1/vm/migrate", 60*time.Second, func() any { return &MigrateRequest{} }, func(ctx context.Context, r any) (any, error) {
		q := r.(*MigrateRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return migrateVM(ctx, c, *q) })
	})
	handle("/v1/vm/shaping", 90*time.Second, func() any { return &ShapingRequest{} }, func(ctx context.Context, r any) (any, error) {
		q := r.(*ShapingRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return applyShaping(ctx, c, *q) })
	})
	handle("/v1/vm/rename", 60*time.Second, func() any { return &RenameRequest{} }, func(ctx context.Context, r any) (any, error) {
		q := r.(*RenameRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return renameVM(ctx, c, *q) })
	})
	handle("/v1/vm/metrics", 30*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return vmMetrics(ctx, c, q.VM, 45) })
	})
	handle("/v1/vm/firewall", 90*time.Second, func() any { return &FirewallRequest{} }, func(ctx context.Context, r any) (any, error) {
		q := r.(*FirewallRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return applyFirewall(ctx, c, *q) })
	})
	handle("/v1/vms/managed", 60*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) {
			vms, err := vmStates(ctx, c, func(n string) bool { return strings.HasPrefix(n, managedPrefix) })
			return map[string]any{"vms": vms}, err
		})
	})
	handle("/v1/vm/cdrom", 60*time.Second, func() any { return &CdromRequest{} }, func(ctx context.Context, r any) (any, error) {
		q := r.(*CdromRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return setCdrom(ctx, c, *q) })
	})
	handle("/v1/iso/delete", 120*time.Second, func() any { return &FileRequest{} }, func(ctx context.Context, r any) (any, error) {
		q := r.(*FileRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return deleteISO(ctx, c, *q) })
	})
	handle("/v1/topology", 60*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return topology(ctx, c) })
	})
	newSnap := func() any { return &SnapshotRequest{} }
	handle("/v1/vm/snapshots", 30*time.Second, newSnap, func(ctx context.Context, r any) (any, error) {
		q := r.(*SnapshotRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) {
			list, err := listSnapshots(ctx, c, q.VM)
			return map[string]any{"snapshots": list}, err
		})
	})
	handle("/v1/vm/snapshot", 60*time.Second, newSnap, func(ctx context.Context, r any) (any, error) {
		q := r.(*SnapshotRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return snapshotAction(ctx, c, *q) })
	})
	handle("/v1/power", 60*time.Second, newVM, func(ctx context.Context, r any) (any, error) {
		q := r.(*VMRequest)
		return withClient(ctx, guard, q.Request, func(c *vim25.Client) (any, error) { return powerReport(ctx, c) })
	})
	mux.HandleFunc("PUT /v1/iso/upload", uploadHandler(guard))
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
