package main

import (
	"context"
	"testing"
)

func TestBackupAndRestore(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-bak", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "bak"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	name := "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.vmdk"
	req := DiskCopyRequest{VM: vm, Datastore: e.store, Name: name, Direction: "backup"}
	if _, err := copyDisk(ctx, e.c, DiskCopyRequest{VM: vm, Datastore: e.store, Name: "../etc/passwd", Direction: "backup"}); err == nil || err.(*Failure).Code != "INVALID_REQUEST" {
		t.Fatalf("a path outside the backup folder was accepted: %v", err)
	}
	if _, err := copyDisk(ctx, e.c, req); err == nil || err.(*Failure).Code != "INVALID_STATE" {
		t.Fatalf("a backup without its snapshot was started: %v", err)
	}
	s, err := snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "create", Name: "lightning-backup"})
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e, s.(map[string]any)["task"].(string))
	r, err := copyDisk(ctx, e.c, req)
	if err != nil {
		t.Fatal(err)
	}
	if st := waitTask(t, e, r.(map[string]any)["task"].(string)); st.State != "success" {
		t.Fatalf("backup copy: %+v", st)
	}
	// Restoring needs the VM off and without snapshots.
	restore := DiskCopyRequest{VM: vm, Datastore: e.store, Name: name, Direction: "restore"}
	if _, err := copyDisk(ctx, e.c, restore); err == nil || err.(*Failure).Code != "DISK_HAS_SNAPSHOTS" {
		t.Fatalf("restore over snapshots: %v", err)
	}
	list, _ := listSnapshots(ctx, e.c, vm)
	s, _ = snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "remove", Snapshot: list[0].ID})
	waitTask(t, e, s.(map[string]any)["task"].(string))
	r, err = copyDisk(ctx, e.c, restore)
	if err != nil {
		t.Fatal(err)
	}
	if st := waitTask(t, e, r.(map[string]any)["task"].(string)); st.State != "success" {
		t.Fatalf("restore copy: %+v", st)
	}
	if _, err := deleteBackup(ctx, e.c, DiskCopyRequest{Datastore: e.store, Name: name}); err != nil {
		t.Fatal(err)
	}
	if _, err := deleteBackup(ctx, e.c, DiskCopyRequest{Datastore: e.store, Name: name}); err != nil {
		t.Fatalf("deleting twice: %v", err)
	}
}
