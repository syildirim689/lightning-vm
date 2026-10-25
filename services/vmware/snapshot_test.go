package main

import (
	"context"
	"testing"
)

func TestSnapshots(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-snap", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "snap"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	if _, err := snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "create"}); err == nil {
		t.Fatal("a snapshot without a name was accepted")
	}
	for _, name := range []string{"before-upgrade", "after-upgrade"} {
		r, err := snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "create", Name: name, Description: "test"})
		if err != nil {
			t.Fatal(err)
		}
		if s := waitTask(t, e, r.(map[string]any)["task"].(string)); s.State != "success" {
			t.Fatalf("create %s: %+v", name, s)
		}
	}
	list, err := listSnapshots(ctx, e.c, vm)
	if err != nil || len(list) != 2 || list[0].Name != "before-upgrade" || list[1].Parent != list[0].ID || !list[1].Current {
		t.Fatalf("list: %+v %v", list, err)
	}
	if _, err := snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "revert", Snapshot: "snapshot-of-another-vm"}); err == nil || err.(*Failure).Code != "SNAPSHOT_NOT_FOUND" {
		t.Fatalf("foreign snapshot: %v", err)
	}
	r, err := snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "revert", Snapshot: list[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, r.(map[string]any)["task"].(string)); s.State != "success" {
		t.Fatalf("revert: %+v", s)
	}
	if now, _ := listSnapshots(ctx, e.c, vm); !now[0].Current {
		t.Fatalf("revert did not make the first snapshot current: %+v", now)
	}
	r, err = snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "remove", Snapshot: list[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e, r.(map[string]any)["task"].(string))
	if now, _ := listSnapshots(ctx, e.c, vm); len(now) != 1 || now[0].ID != list[0].ID {
		t.Fatalf("after remove: %+v", now)
	}
}
