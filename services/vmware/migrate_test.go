package main

import (
	"context"
	"testing"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

func TestMigrateToAnotherHost(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	// Into the cluster, where other hosts can take it.
	clusters, _ := retrieve[mo.ClusterComputeResource](ctx, e.c, "ClusterComputeResource", []string{"resourcePool", "host"})
	if len(clusters) == 0 {
		t.Fatal("no cluster in the simulator")
	}
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-move", Template: e.template, Pool: clusters[0].ResourcePool.Value, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "move"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}
	var v mo.VirtualMachine
	if err := object.NewVirtualMachine(e.c, ref).Properties(ctx, ref, []string{"runtime.host"}, &v); err != nil {
		t.Fatal(err)
	}
	// Any host of the cluster other than the one it runs on.
	var target string
	for _, h := range clusters[0].Host {
		if v.Runtime.Host == nil || h.Value != v.Runtime.Host.Value {
			target = h.Value
		}
	}
	if target == "" {
		t.Fatal("the simulated cluster has no other host")
	}
	if _, err := migrateVM(ctx, e.c, MigrateRequest{VM: vm}); err == nil {
		t.Fatal("a move without a target was accepted")
	}
	r, err := migrateVM(ctx, e.c, MigrateRequest{VM: vm, Host: target})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, r.(map[string]any)["task"].(string)); s.State != "success" {
		t.Fatalf("migrate: %+v", s)
	}
	if err := object.NewVirtualMachine(e.c, ref).Properties(ctx, ref, []string{"runtime.host"}, &v); err != nil || v.Runtime.Host.Value != target {
		t.Fatalf("still on %v (%v)", v.Runtime.Host, err)
	}
	if again, _ := migrateVM(ctx, e.c, MigrateRequest{VM: vm, Host: target}); again.(map[string]any)["already"] != true {
		t.Fatal("moving to the host it is on should be a no-op")
	}
}
