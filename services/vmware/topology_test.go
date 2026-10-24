package main

import (
	"context"
	"testing"
)

func TestTopology(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-topo", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "topo"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	if _, err := powerAction(ctx, e.c, VMRequest{VM: vm, Action: "on"}); err != nil {
		t.Fatal(err)
	}
	topo, err := topology(ctx, e.c)
	if err != nil {
		t.Fatal(err)
	}
	if len(topo.Hosts) == 0 || len(topo.Datastores) == 0 || len(topo.Compute) == 0 {
		t.Fatalf("empty inventory: %+v", topo)
	}
	if topo.Hosts[0].CPUTotalMhz <= 0 || topo.Hosts[0].MemTotalMb <= 0 || topo.Hosts[0].Compute == "" {
		t.Fatalf("host totals missing: %+v", topo.Hosts[0])
	}
	found := false
	for _, v := range topo.VMs {
		if v.MoRef == vm {
			found = v.Power == "poweredOn" && v.Host != ""
		}
	}
	if !found {
		t.Fatalf("managed VM missing or wrong: %+v", topo.VMs)
	}
	if topo.OtherVMs == 0 {
		t.Fatal("the simulator's own VMs count as other VMs")
	}
}
