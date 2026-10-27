package main

import (
	"context"
	"strings"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// ResizeRequest: new vCPU, memory and size of the first disk. The disk only grows; the guest's cloud-init
// (growpart, resize_rootfs) extends the partition and file system on the next boot.
type ResizeRequest struct {
	Request
	VM       string `json:"vm"`
	VCPU     int32  `json:"vcpu"`
	MemoryMB int64  `json:"memoryMb"`
	DiskGB   int64  `json:"diskGb"`
}

func resizeVM(ctx context.Context, c *vim25.Client, r ResizeRequest) (any, error) {
	if r.VCPU < 1 || r.MemoryMB < 256 || r.DiskGB < 1 {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "vcpu, memoryMb and diskGb are required"}
	}
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM}
	vm := object.NewVirtualMachine(c, ref)
	var v mo.VirtualMachine
	if err := vm.Properties(ctx, ref, []string{"name", "snapshot", "config.hardware.device"}, &v); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(v.Name, managedPrefix) {
		return nil, &Failure{Code: "NOT_MANAGED", Message: "refusing to change a VM this platform did not create"}
	}
	spec := types.VirtualMachineConfigSpec{NumCPUs: r.VCPU, MemoryMB: r.MemoryMB}
	disks := object.VirtualDeviceList(v.Config.Hardware.Device).SelectByType((*types.VirtualDisk)(nil))
	if len(disks) > 0 {
		d := disks[0].(*types.VirtualDisk)
		want := r.DiskGB << 30
		switch {
		case want < d.CapacityInBytes:
			return nil, &Failure{Code: "DISK_SHRINK_NOT_SUPPORTED", Message: "a disk can only grow"}
		case want > d.CapacityInBytes:
			// vSphere cannot extend a disk that has snapshots on it.
			if v.Snapshot != nil && len(v.Snapshot.RootSnapshotList) > 0 {
				return nil, &Failure{Code: "DISK_HAS_SNAPSHOTS", Message: "remove the snapshots before growing the disk"}
			}
			d.CapacityInBytes = want
			d.CapacityInKB = want >> 10
			spec.DeviceChange = []types.BaseVirtualDeviceConfigSpec{&types.VirtualDeviceConfigSpec{Operation: types.VirtualDeviceConfigSpecOperationEdit, Device: d}}
		}
	}
	task, err := vm.Reconfigure(ctx, spec)
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}

// RenameRequest: an existing VM taken over by the panel gets the managed name ("lvm-<server id>"), which is how
// the panel finds it from then on. Only an unmanaged VM can be taken over, and only into a managed name.
type RenameRequest struct {
	Request
	VM   string `json:"vm"`
	Name string `json:"name"`
}

func renameVM(ctx context.Context, c *vim25.Client, r RenameRequest) (any, error) {
	if !strings.HasPrefix(r.Name, managedPrefix) || len(r.Name) > 80 {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "the new name must be a managed name"}
	}
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM}
	vm := object.NewVirtualMachine(c, ref)
	var v mo.VirtualMachine
	if err := vm.Properties(ctx, ref, []string{"name", "config.template", "config.hardware.device"}, &v); err != nil {
		return nil, err
	}
	if v.Name == r.Name {
		return map[string]any{"name": r.Name, "diskGb": firstDiskGB(v)}, nil // done before (a retry)
	}
	if strings.HasPrefix(v.Name, managedPrefix) || (v.Config != nil && v.Config.Template) {
		return nil, &Failure{Code: "NOT_IMPORTABLE", Message: "the VM is already managed or is a template"}
	}
	task, err := vm.Rename(ctx, r.Name)
	if err != nil {
		return nil, err
	}
	if err := task.Wait(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"name": r.Name, "diskGb": firstDiskGB(v)}, nil
}

// The size of the first disk in whole GB (rounded up), or 0 without a disk.
func firstDiskGB(v mo.VirtualMachine) int64 {
	if v.Config == nil {
		return 0
	}
	disks := object.VirtualDeviceList(v.Config.Hardware.Device).SelectByType((*types.VirtualDisk)(nil))
	if len(disks) == 0 {
		return 0
	}
	return (disks[0].(*types.VirtualDisk).CapacityInBytes + (1<<30 - 1)) >> 30
}
