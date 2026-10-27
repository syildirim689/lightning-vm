package main

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Extra disks: more thin disks on the VM's first disk controller, next to its system disk (the first disk, which is
// never touched here). A new disk appears in the guest as an empty device; the customer partitions and mounts it.

type DiskRequest struct {
	Request
	VM     string `json:"vm"`
	SizeGB int64  `json:"sizeGb"`
	Key    int32  `json:"key"` // the disk to remove (its device key)
}

type DiskInfo struct {
	Key    int32  `json:"key"`
	Label  string `json:"label"`
	SizeGB int64  `json:"sizeGb"`
	System bool   `json:"system"`
}

func managedVM(ctx context.Context, c *vim25.Client, vmRef string) (*object.VirtualMachine, object.VirtualDeviceList, error) {
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: vmRef}
	vm := object.NewVirtualMachine(c, ref)
	var v mo.VirtualMachine
	if err := vm.Properties(ctx, ref, []string{"name", "config.hardware.device"}, &v); err != nil {
		return nil, nil, err
	}
	if !strings.HasPrefix(v.Name, managedPrefix) {
		return nil, nil, &Failure{Code: "NOT_MANAGED", Message: "refusing to change a VM this platform did not create"}
	}
	return vm, object.VirtualDeviceList(v.Config.Hardware.Device), nil
}

func listDisks(ctx context.Context, c *vim25.Client, r DiskRequest) (any, error) {
	_, devices, err := managedVM(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	out := []DiskInfo{}
	for i, d := range devices.SelectByType((*types.VirtualDisk)(nil)) {
		disk := d.(*types.VirtualDisk)
		out = append(out, DiskInfo{Key: disk.Key, Label: devices.Name(disk), SizeGB: disk.CapacityInBytes >> 30, System: i == 0})
	}
	return map[string]any{"disks": out}, nil
}

func addDisk(ctx context.Context, c *vim25.Client, r DiskRequest) (any, error) {
	if r.SizeGB < 1 || r.SizeGB > 65536 {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "sizeGb must be between 1 and 65536"}
	}
	vm, devices, err := managedVM(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	disks := devices.SelectByType((*types.VirtualDisk)(nil))
	if len(disks) == 0 {
		return nil, &Failure{Code: "VM_HAS_NO_DISK", Message: "the VM has no system disk"}
	}
	controller, err := devices.FindDiskController("")
	if err != nil {
		return nil, &Failure{Code: "NO_DISK_CONTROLLER", Message: "no free disk controller slot"}
	}
	// On the system disk's datastore, in the VM's folder; thin.
	sys := disks[0].(*types.VirtualDisk).Backing.(*types.VirtualDiskFlatVer2BackingInfo)
	ds := sys.Datastore
	// Its own file next to the system disk (an empty name would reuse the system disk's name on some versions).
	name := strings.TrimSuffix(sys.FileName, ".vmdk") + "_extra" + strconv.FormatInt(time.Now().UnixNano()%1_000_000_000, 36) + ".vmdk"
	disk := devices.CreateDisk(controller, *ds, name)
	disk.CapacityInKB = r.SizeGB * 1024 * 1024
	disk.CapacityInBytes = r.SizeGB << 30
	disk.Backing.(*types.VirtualDiskFlatVer2BackingInfo).ThinProvisioned = types.NewBool(true)
	spec := types.VirtualMachineConfigSpec{DeviceChange: []types.BaseVirtualDeviceConfigSpec{&types.VirtualDeviceConfigSpec{
		Operation: types.VirtualDeviceConfigSpecOperationAdd, FileOperation: types.VirtualDeviceConfigSpecFileOperationCreate, Device: disk}}}
	task, err := vm.Reconfigure(ctx, spec)
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}

// removeDisk detaches an extra disk and deletes its file; the system disk is refused.
func removeDisk(ctx context.Context, c *vim25.Client, r DiskRequest) (any, error) {
	vm, devices, err := managedVM(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	disks := devices.SelectByType((*types.VirtualDisk)(nil))
	for i, d := range disks {
		if d.GetVirtualDevice().Key != r.Key {
			continue
		}
		if i == 0 {
			return nil, &Failure{Code: "SYSTEM_DISK", Message: "the system disk cannot be removed"}
		}
		spec := types.VirtualMachineConfigSpec{DeviceChange: []types.BaseVirtualDeviceConfigSpec{&types.VirtualDeviceConfigSpec{
			Operation: types.VirtualDeviceConfigSpecOperationRemove, FileOperation: types.VirtualDeviceConfigSpecFileOperationDestroy, Device: d}}}
		task, err := vm.Reconfigure(ctx, spec)
		if err != nil {
			return nil, err
		}
		return map[string]any{"task": task.Reference().Value}, nil
	}
	return map[string]any{"task": "", "gone": true}, nil
}
