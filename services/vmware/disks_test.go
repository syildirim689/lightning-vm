package main

import (
	"context"
	"testing"
)

func TestExtraDisks(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-disks", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "disks"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	list := func() []DiskInfo {
		r, err := listDisks(ctx, e.c, DiskRequest{VM: vm})
		if err != nil {
			t.Fatal(err)
		}
		return r.(map[string]any)["disks"].([]DiskInfo)
	}
	before := list()
	if len(before) != 1 || !before[0].System {
		t.Fatalf("want one system disk, got %+v", before)
	}
	if _, err := addDisk(ctx, e.c, DiskRequest{VM: vm, SizeGB: 0}); err == nil {
		t.Fatal("a 0 GB disk was accepted")
	}
	r, err := addDisk(ctx, e.c, DiskRequest{VM: vm, SizeGB: 50})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, r.(map[string]any)["task"].(string)); s.State != "success" {
		t.Fatalf("add: %+v", s)
	}
	after := list()
	if len(after) != 2 || after[1].SizeGB != 50 || after[1].System {
		t.Fatalf("want a 50 GB extra disk, got %+v", after)
	}
	if _, err := removeDisk(ctx, e.c, DiskRequest{VM: vm, Key: after[0].Key}); err == nil || err.(*Failure).Code != "SYSTEM_DISK" {
		t.Fatalf("the system disk was not protected: %v", err)
	}
	r, err = removeDisk(ctx, e.c, DiskRequest{VM: vm, Key: after[1].Key})
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e, r.(map[string]any)["task"].(string))
	if n := len(list()); n != 1 {
		t.Fatalf("want the extra disk gone, have %d disks", n)
	}
}
