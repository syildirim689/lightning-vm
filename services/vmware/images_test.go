package main

import (
	"context"
	"testing"
)

func TestPersonalImage(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-src", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "src"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	if _, err := templateFromVM(ctx, e.c, ImageRequest{VM: vm, Name: "my-image"}); err == nil {
		t.Fatal("an unmanaged name was accepted")
	}
	r, err := templateFromVM(ctx, e.c, ImageRequest{VM: vm, Name: "lvm-img-1"})
	if err != nil {
		t.Fatal(err)
	}
	st := waitTask(t, e, r.(map[string]any)["task"].(string))
	if st.State != "success" {
		t.Fatalf("template: %+v", st)
	}
	again, _ := templateFromVM(ctx, e.c, ImageRequest{VM: vm, Name: "lvm-img-1"})
	tpl := again.(map[string]any)["template"].(string)
	if tpl == "" {
		t.Fatal("a retry did not find the template")
	}
	// A server can be made from it like from any template.
	n, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-from-img", Template: tpl, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "from"})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, n["task"].(string)); s.State != "success" {
		t.Fatalf("clone from the image: %+v", s)
	}
	if _, err := deleteTemplate(ctx, e.c, ImageRequest{Name: "lvm-img-1"}); err != nil {
		t.Fatal(err)
	}
	if st, _ := findVM(ctx, e.c, "lvm-img-1"); st != nil {
		t.Fatal("the template is still there")
	}
}
