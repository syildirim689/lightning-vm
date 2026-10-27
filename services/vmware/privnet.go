package main

import (
	"context"
	"strings"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Private networks: a distributed port group per customer network, on the switch of a port group the admin chose for
// the location, tagged with the network's own VLAN (isolation between customers). A server joins with a second NIC on it.

type PortgroupRequest struct {
	Request
	Reference string `json:"reference"` // a distributed port group on the switch to use (create)
	Portgroup string `json:"portgroup"` // the network's port group (delete, NICs)
	Name      string `json:"name"`      // "lvm-net-<network id>"
	VLAN      int32  `json:"vlan"`
	VM        string `json:"vm"`
}

func switchOfPortgroup(ctx context.Context, c *vim25.Client, moref string) (*object.DistributedVirtualSwitch, error) {
	ref := types.ManagedObjectReference{Type: "DistributedVirtualPortgroup", Value: moref}
	var pg mo.DistributedVirtualPortgroup
	if err := object.NewDistributedVirtualPortgroup(c, ref).Properties(ctx, ref, []string{"config.distributedVirtualSwitch"}, &pg); err != nil {
		return nil, err
	}
	if pg.Config.DistributedVirtualSwitch == nil {
		return nil, &Failure{Code: "NETWORK_NOT_FOUND", Message: "the reference is not a distributed port group"}
	}
	return object.NewDistributedVirtualSwitch(c, *pg.Config.DistributedVirtualSwitch), nil
}

// createPortgroup adds the network's port group (static binding, its VLAN) and returns its moref; an existing one of
// the same name is returned as it is (a retry).
func createPortgroup(ctx context.Context, c *vim25.Client, r PortgroupRequest) (any, error) {
	if !strings.HasPrefix(r.Name, managedPrefix+"net-") || r.VLAN < 1 || r.VLAN > 4094 {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "a managed name and a VLAN (1-4094) are required"}
	}
	dvs, err := switchOfPortgroup(ctx, c, r.Reference)
	if err != nil {
		return nil, err
	}
	if moref, err := portgroupNamed(ctx, c, r.Name); err != nil || moref != "" {
		return map[string]any{"portgroup": moref}, err
	}
	spec := types.DVPortgroupConfigSpec{Name: r.Name, Type: string(types.DistributedVirtualPortgroupPortgroupTypeEarlyBinding), NumPorts: 32,
		AutoExpand: types.NewBool(true),
		DefaultPortConfig: &types.VMwareDVSPortSetting{Vlan: &types.VmwareDistributedVirtualSwitchVlanIdSpec{VlanId: r.VLAN}}}
	task, err := dvs.AddPortgroup(ctx, []types.DVPortgroupConfigSpec{spec})
	if err != nil {
		return nil, err
	}
	if err := task.Wait(ctx); err != nil {
		return nil, err
	}
	moref, err := portgroupNamed(ctx, c, r.Name)
	return map[string]any{"portgroup": moref}, err
}

func portgroupNamed(ctx context.Context, c *vim25.Client, name string) (string, error) {
	pgs, err := retrieve[mo.DistributedVirtualPortgroup](ctx, c, "DistributedVirtualPortgroup", []string{"name"})
	if err != nil {
		return "", err
	}
	for _, p := range pgs {
		if p.Name == name {
			return p.Self.Value, nil
		}
	}
	return "", nil
}

// deletePortgroup removes a network's port group; one already gone is fine. Only managed ones are touched.
func deletePortgroup(ctx context.Context, c *vim25.Client, r PortgroupRequest) (any, error) {
	ref := types.ManagedObjectReference{Type: "DistributedVirtualPortgroup", Value: r.Portgroup}
	pg := object.NewDistributedVirtualPortgroup(c, ref)
	var p mo.DistributedVirtualPortgroup
	if err := pg.Properties(ctx, ref, []string{"name"}, &p); err != nil {
		if strings.Contains(err.Error(), "ManagedObjectNotFound") || strings.Contains(err.Error(), "has already been deleted") {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if !strings.HasPrefix(p.Name, managedPrefix+"net-") {
		return nil, &Failure{Code: "NOT_MANAGED", Message: "refusing to delete a port group this platform did not create"}
	}
	task, err := pg.Destroy(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{}, task.Wait(ctx)
}

// addNic gives the VM a vmxnet3 NIC on the network's port group (none if it has one there already); returns the task.
func addNic(ctx context.Context, c *vim25.Client, r PortgroupRequest) (any, error) {
	vm, devices, err := managedVM(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	if nicOn(devices, r.Portgroup) != nil {
		return map[string]any{"task": ""}, nil
	}
	backing, err := networkBacking(ctx, c, r.Portgroup)
	if err != nil {
		return nil, &Failure{Code: "NETWORK_NOT_FOUND", Message: "network not found"}
	}
	nic, err := object.EthernetCardTypes().CreateEthernetCard("vmxnet3", backing)
	if err != nil {
		return nil, err
	}
	task, err := vm.Reconfigure(ctx, types.VirtualMachineConfigSpec{DeviceChange: []types.BaseVirtualDeviceConfigSpec{
		&types.VirtualDeviceConfigSpec{Operation: types.VirtualDeviceConfigSpecOperationAdd, Device: nic}}})
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}

func removeNic(ctx context.Context, c *vim25.Client, r PortgroupRequest) (any, error) {
	vm, devices, err := managedVM(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	nic := nicOn(devices, r.Portgroup)
	if nic == nil {
		return map[string]any{"task": ""}, nil
	}
	task, err := vm.Reconfigure(ctx, types.VirtualMachineConfigSpec{DeviceChange: []types.BaseVirtualDeviceConfigSpec{
		&types.VirtualDeviceConfigSpec{Operation: types.VirtualDeviceConfigSpecOperationRemove, Device: nic}}})
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}

// nicMac is the MAC address of the VM's NIC on the port group (empty if none), for the guest's network settings.
func nicMac(ctx context.Context, c *vim25.Client, r PortgroupRequest) (any, error) {
	_, devices, err := managedVM(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	mac := ""
	if nic := nicOn(devices, r.Portgroup); nic != nil {
		mac = nic.(types.BaseVirtualEthernetCard).GetVirtualEthernetCard().MacAddress
	}
	return map[string]any{"mac": mac}, nil
}

func nicOn(devices object.VirtualDeviceList, portgroup string) types.BaseVirtualDevice {
	for _, d := range devices.SelectByType((*types.VirtualEthernetCard)(nil)) {
		if b, ok := d.GetVirtualDevice().Backing.(*types.VirtualEthernetCardDistributedVirtualPortBackingInfo); ok && b.Port.PortgroupKey != "" {
			if b.Port.PortgroupKey == portgroup {
				return d
			}
		}
	}
	return nil
}
