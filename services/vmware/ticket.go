package main

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

type TicketRequest struct {
	Request
	VM string `json:"vm"` // VirtualMachine managed object id, e.g. "vm-42"
}

// ConsoleTicket is everything the console gateway needs to reach the VM's WebMKS endpoint and
// verify it. It goes from here to the API and into Redis; it never reaches the browser.
type ConsoleTicket struct {
	URL      string   `json:"url"`
	Host     string   `json:"host"`
	SHA1     string   `json:"sha1,omitempty"`
	SHA256   []string `json:"sha256,omitempty"`
	CertPEM  string   `json:"certPem,omitempty"`
	VMName   string   `json:"vmName"`
	PowerOn  bool     `json:"poweredOn"`
	Endpoint string   `json:"endpoint"` // the connection's own host, for logs
}

func normalizeThumbprint(s string) string { return strings.ToLower(strings.ReplaceAll(s, ":", "")) }

// consoleTicket checks the VM is powered on and asks ESXi/vCenter for a single-use WebMKS ticket.
func consoleTicket(ctx context.Context, g *netGuard, r TicketRequest) (*ConsoleTicket, error) {
	if r.VM == "" {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "vm is required"}
	}
	c, sm, err := connect(ctx, g, r.Request)
	if err != nil {
		return nil, err
	}
	defer sm.Logout(context.WithoutCancel(ctx))

	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM}
	vm := object.NewVirtualMachine(c, ref)
	var props mo.VirtualMachine
	if err := vm.Properties(ctx, ref, []string{"name", "runtime.powerState"}, &props); err != nil {
		return nil, &Failure{Code: "VM_NOT_FOUND", Message: "virtual machine not found"}
	}
	if props.Runtime.PowerState != types.VirtualMachinePowerStatePoweredOn {
		return nil, &Failure{Code: "VM_POWERED_OFF", Message: "the console needs a powered-on virtual machine"}
	}
	t, err := vm.AcquireTicket(ctx, "webmks")
	if err != nil {
		return nil, classify(err)
	}
	host := t.Host
	if host == "" {
		host = r.Host // ESXi answering for itself may omit the host
	}
	port := int(t.Port)
	if port == 0 {
		port = 443
	}
	out := &ConsoleTicket{Host: host, SHA1: normalizeThumbprint(t.SslThumbprint), CertPEM: t.SslCertificate, VMName: props.Name, PowerOn: true, Endpoint: r.Host,
		URL: fmt.Sprintf("wss://%s/ticket/%s", net.JoinHostPort(host, strconv.Itoa(port)), t.Ticket)}
	if t.Url != "" {
		out.URL = t.Url
	}
	for _, tp := range t.CertThumbprintList {
		if strings.EqualFold(tp.HashAlgorithm, "sha256") || strings.EqualFold(tp.HashAlgorithm, "SHA-256") {
			out.SHA256 = append(out.SHA256, normalizeThumbprint(tp.Thumbprint))
		}
	}
	// The gateway must be able to verify the host it connects to; refuse tickets it could not verify.
	if out.SHA1 == "" && len(out.SHA256) == 0 && out.CertPEM == "" {
		return nil, &Failure{Code: "CONSOLE_TLS_UNVERIFIABLE", Message: "ticket carries no certificate thumbprint"}
	}
	return out, nil
}
