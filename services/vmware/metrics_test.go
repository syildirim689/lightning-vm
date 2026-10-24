package main

import (
	"context"
	"testing"

	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Against govmomi's simulator, which serves generated realtime counters: proves the query and the
// mapping (units, aggregate instance), not real vCenter numbers.
func TestVMMetrics(t *testing.T) {
	host, port, srv := startSim(t, simulator.VPX())
	req := Request{Host: host, Port: port, Username: "user", Password: "pass", TLS: TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)}}
	ctx := context.Background()
	c, sm, err := connect(ctx, testGuard(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer sm.Logout(ctx)
	vms, _ := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"runtime.powerState"})
	var on string
	for _, v := range vms {
		if v.Runtime.PowerState == types.VirtualMachinePowerStatePoweredOn {
			on = v.Self.Value
			break
		}
	}
	if on == "" {
		t.Fatal("simulator has no powered-on VM")
	}
	m, err := vmMetrics(ctx, c, on, 10)
	if err != nil {
		t.Fatal(err)
	}
	if m.Interval != 20 || len(m.Samples) == 0 {
		t.Fatalf("want realtime samples, got %+v", m)
	}
	s := m.Samples[len(m.Samples)-1]
	if s.CPU == nil || s.Mem == nil || s.T.IsZero() {
		t.Fatalf("cpu/mem missing from last sample: %+v", s)
	}
	if _, ok := m.Quick["uptimeSeconds"]; !ok {
		t.Fatal("quick stats missing")
	}
}
