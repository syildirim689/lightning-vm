package main

import (
	"context"
	"testing"
)

func TestPowerReport(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-pwr", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "pwr"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	if _, err := powerAction(ctx, e.c, VMRequest{VM: vm, Action: "on"}); err != nil {
		t.Fatal(err)
	}
	r, err := powerReport(ctx, e.c)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Hosts) == 0 || r.Hosts[0].CPUTotalMhz <= 0 || r.Hosts[0].CoreMhz <= 0 || !r.Hosts[0].Connected {
		t.Fatalf("hosts: %+v", r.Hosts)
	}
	found := false
	for _, v := range r.VMs {
		found = found || (v.Name == "lvm-pwr" && v.Host != "")
		if v.Name == "lvm-pwr" {
			t.Logf("traffic samples: %d", len(v.Traffic))
			for _, s := range v.Traffic {
				if s.T.IsZero() || s.Rx < 0 || s.Tx < 0 {
					t.Fatalf("bad traffic sample: %+v", s)
				}
			}
		}
	}
	if !found {
		t.Fatalf("running managed VM missing: %+v", r.VMs)
	}
	t.Logf("simulated host watts reported: %v", r.Hosts[0].Watts != nil)
}
