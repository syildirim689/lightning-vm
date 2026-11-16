package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/vmware/govmomi/task"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// An HTTPS server that is not vSphere, as a connection whose certificate is pinned.
func tlsServer(t *testing.T, h http.Handler) Request {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(u.Port())
	return req(u.Hostname(), port, TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)})
}

// NOT_VSPHERE means that nothing answered as a vSphere API at /sdk; an error from a vSphere that did answer
// has its own code.
func TestNotVSphereOnlyWhenNothingAnswersAtSDK(t *testing.T) {
	_, err := discover(context.Background(), testGuard(), tlsServer(t, http.NotFoundHandler()))
	if f := classify(err); f.Code != "NOT_VSPHERE" {
		t.Fatalf("want NOT_VSPHERE, got %s", f.Code)
	}
	if f := classify(errors.New("ServerFaultCode: something this adapter does not know")); f.Code != "VMWARE_ERROR" {
		t.Fatalf("want VMWARE_ERROR, got %s", f.Code)
	}
	busy := task.Error{LocalizedMethodFault: &types.LocalizedMethodFault{Fault: &types.InvalidState{}, LocalizedMessage: "busy"}}
	if f := classify(busy); f.Code != "INVALID_STATE" || f.Message != "busy" {
		t.Fatalf("a failed task must keep its fault's code, got %s (%s)", f.Code, f.Message)
	}
	if f := classify(context.Canceled); f.Code != "TIMEOUT" {
		t.Fatalf("want TIMEOUT for a cancelled request, got %s", f.Code)
	}
}

// An endpoint that accepts the connection and then says nothing must not hold the request past its deadline:
// govmomi's version lookup carries no context of its own.
func TestSilentEndpointDoesNotHoldTheRequest(t *testing.T) {
	old := dialTimeout
	dialTimeout = 300 * time.Millisecond
	t.Cleanup(func() { dialTimeout = old })
	// The handler is let go by the test, not by the client hanging up: a server only notices a closed
	// connection once the request body has been read, and this handler reads nothing.
	release := make(chan struct{})
	silent := tlsServer(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release) }) // registered after the server's Close, so it runs before it
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := discover(ctx, testGuard(), silent)
		done <- err
	}()
	select {
	case err := <-done:
		if f := classify(err); f.Code != "TIMEOUT" {
			t.Fatalf("want TIMEOUT, got %s", f.Code)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the request is still held 13 s after its deadline")
	}
}

func TestFailureStatus(t *testing.T) {
	want := map[int][]string{
		404: {"SNAPSHOT_NOT_FOUND"},
		409: {"FIREWALL_NEEDS_DVS", "FIREWALL_NO_PORT", "CONSOLE_TLS_UNVERIFIABLE", "WRITE_RESTRICTED", "INSUFFICIENT_RESOURCES", "DUPLICATE_NAME"},
		400: {"FIREWALL_TOO_MANY_RULES"},
		502: {"FIREWALL_APPLY_FAILED", "VMWARE_ERROR", "NOT_VSPHERE", "TASK_FAILED"},
	}
	for status, codes := range want {
		for _, code := range codes {
			if got := failureStatus(code); got != status {
				t.Errorf("%s: want %d, got %d", code, status, got)
			}
		}
	}
}

// vCenter returns no configuration for an inaccessible or orphaned VM: a coded failure, not a panic.
func TestVMWithoutConfiguration(t *testing.T) {
	_, err := vmDevices(mo.VirtualMachine{})
	if f := classify(err); f.Code != "INVALID_STATE" {
		t.Fatalf("want INVALID_STATE, got %s", f.Code)
	}
}
