package main

import (
	"context"
	"strings"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Personal images: a customer's server cloned into a template ("lvm-img-<image id>") next to it, which the panel then
// offers to that customer as an image. The server keeps running; its disk is copied as it is at that moment.

type ImageRequest struct {
	Request
	VM        string `json:"vm"`
	Name      string `json:"name"`
	Datastore string `json:"datastore"`
}

func templateFromVM(ctx context.Context, c *vim25.Client, r ImageRequest) (any, error) {
	if !strings.HasPrefix(r.Name, managedPrefix+"img-") {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "a managed image name is required"}
	}
	if existing, err := findVM(ctx, c, r.Name); err != nil {
		return nil, err
	} else if existing != nil {
		return map[string]any{"task": "", "template": existing.MoRef}, nil // a retry
	}
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM}
	vm := object.NewVirtualMachine(c, ref)
	var v mo.VirtualMachine
	if err := vm.Properties(ctx, ref, []string{"name", "parent", "datastore"}, &v); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(v.Name, managedPrefix) || strings.HasPrefix(v.Name, managedPrefix+"img-") {
		return nil, &Failure{Code: "NOT_MANAGED", Message: "only a server of this platform can become an image"}
	}
	if v.Parent == nil {
		return nil, &Failure{Code: "INVALID_STATE", Message: "the VM is not in a folder"}
	}
	spec := types.VirtualMachineCloneSpec{Template: true, PowerOn: false}
	if r.Datastore != "" {
		ds := types.ManagedObjectReference{Type: "Datastore", Value: r.Datastore}
		spec.Location.Datastore = &ds
	}
	task, err := vm.Clone(ctx, object.NewFolder(c, *v.Parent), r.Name, spec)
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}

// deleteTemplate removes a personal image's template (only "lvm-img-" ones); one already gone is fine.
func deleteTemplate(ctx context.Context, c *vim25.Client, r ImageRequest) (any, error) {
	st, err := findVM(ctx, c, r.Name)
	if err != nil {
		return nil, err
	}
	if st == nil {
		return map[string]any{}, nil
	}
	if !strings.HasPrefix(st.Name, managedPrefix+"img-") {
		return nil, &Failure{Code: "NOT_MANAGED", Message: "refusing to delete a template this platform did not make"}
	}
	task, err := object.NewVirtualMachine(c, types.ManagedObjectReference{Type: "VirtualMachine", Value: st.MoRef}).Destroy(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{}, task.Wait(ctx)
}
