package main

import (
	"context"
	"encoding/base64"
	"sort"
	"strings"

	"github.com/vmware/govmomi/fault"
	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/property"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Provisioning uses vCenter's CloneVM_Task with cloud-init guest customization
// (CustomizationCloudinitPrep, vSphere 7.0 U3+). Standalone ESXi cannot clone through the API.

type CloneRequest struct {
	Request
	Name      string `json:"name"`      // "lvm-<server id>": the idempotency anchor in VMware
	Template  string `json:"template"`  // template VM moref
	Pool      string `json:"pool"`      // resource pool moref
	Datastore string `json:"datastore"` // datastore moref
	Network   string `json:"network"`   // network or dvportgroup moref
	VCPU      int32  `json:"vcpu"`
	MemoryMB  int64  `json:"memoryMb"`
	DiskGB    int64  `json:"diskGb"`
	Metadata  string `json:"metadata"` // cloud-init metadata (instance id, hostname, network)
	Userdata  string `json:"userdata"` // cloud-init user data (SSH keys); never logged
	ServerID  string `json:"serverId"`
	// "cloudinit": vCenter's native cloud-init customization (7.0U3+). "guestinfo": the same data in
	// guestinfo.* extraConfig for cloud-init's VMware datasource (any version; cloud-init 21.3+ in the template).
	Customization string `json:"customization"`
	// Hardware options from the panel's server settings.
	CPUHotAdd    bool `json:"cpuHotAdd"`
	MemoryHotAdd bool `json:"memoryHotAdd"`
	NestedHV     bool `json:"nestedHv"` // hardware virtualization exposed to the guest (nested ESXi, KVM, Hyper-V)
	// "appliance": no cloud-init; the template reads its settings from vApp (OVF) properties, as the nested ESXi
	// appliance does. Matching template properties get these values, and each is also set as extraConfig.
	VAppProperties map[string]string `json:"vappProperties"`
}

type VMState struct {
	MoRef        string   `json:"moref"`
	Name         string   `json:"name"`
	PowerState   string   `json:"powerState"`
	ToolsRunning bool     `json:"toolsRunning"`
	IPs          []string `json:"ips"`
	ServerID     string   `json:"serverId,omitempty"`
}

type TaskState struct {
	State string `json:"state"` // queued, running, success, error
	VM    string `json:"vm,omitempty"`
	Code  string `json:"code,omitempty"`
	Error string `json:"error,omitempty"`
}

const managedPrefix = "lvm-"

func vmStates(ctx context.Context, c *vim25.Client, match func(name string) bool) ([]VMState, error) {
	vms, err := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"name", "runtime.powerState", "guest", "config.extraConfig"})
	if err != nil {
		return nil, err
	}
	out := []VMState{}
	for _, v := range vms {
		if !match(v.Name) {
			continue
		}
		s := VMState{MoRef: v.Self.Value, Name: v.Name, PowerState: string(v.Runtime.PowerState), IPs: []string{}}
		if v.Guest != nil {
			s.ToolsRunning = v.Guest.ToolsRunningStatus == string(types.VirtualMachineToolsRunningStatusGuestToolsRunning)
			for _, n := range v.Guest.Net {
				s.IPs = append(s.IPs, n.IpAddress...)
			}
		}
		if v.Config != nil {
			for _, o := range v.Config.ExtraConfig {
				if kv := o.GetOptionValue(); kv.Key == "lightning.server-id" {
					s.ServerID, _ = kv.Value.(string)
				}
			}
		}
		out = append(out, s)
	}
	return out, nil
}

func findVM(ctx context.Context, c *vim25.Client, name string) (*VMState, error) {
	found, err := vmStates(ctx, c, func(n string) bool { return n == name })
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return &found[0], nil
}

func networkBacking(ctx context.Context, c *vim25.Client, moref string) (types.BaseVirtualDeviceBackingInfo, error) {
	kind := "Network"
	if strings.HasPrefix(moref, "dvportgroup-") {
		kind = "DistributedVirtualPortgroup"
	}
	ref := types.ManagedObjectReference{Type: kind, Value: moref}
	if kind == "Network" {
		return object.NewNetwork(c, ref).EthernetCardBackingInfo(ctx)
	}
	return object.NewDistributedVirtualPortgroup(c, ref).EthernetCardBackingInfo(ctx)
}

// cloneVM starts the clone unless a VM with this name already exists, in which case that VM is
// returned: a retry after a timeout must never create a second machine.
func cloneVM(ctx context.Context, g *netGuard, r CloneRequest) (map[string]any, error) {
	if !strings.HasPrefix(r.Name, managedPrefix) || r.Template == "" || r.Pool == "" || r.Datastore == "" || r.Network == "" {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "name, template, pool, datastore and network are required"}
	}
	c, sm, err := connect(ctx, g, r.Request)
	if err != nil {
		return nil, err
	}
	defer sm.Logout(context.WithoutCancel(ctx))
	if c.ServiceContent.About.ApiType != "VirtualCenter" {
		return nil, &Failure{Code: "PROVISIONING_NOT_SUPPORTED", Message: "cloning needs vCenter"}
	}
	if existing, err := findVM(ctx, c, r.Name); err != nil {
		return nil, classify(err)
	} else if existing != nil {
		return map[string]any{"vm": existing.MoRef, "existed": true}, nil
	}

	template := object.NewVirtualMachine(c, types.ManagedObjectReference{Type: "VirtualMachine", Value: r.Template})
	var tpl mo.VirtualMachine
	if err := template.Properties(ctx, template.Reference(), []string{"parent", "config.vAppConfig"}, &tpl); err != nil || tpl.Parent == nil {
		return nil, &Failure{Code: "TEMPLATE_NOT_FOUND", Message: "template not found"}
	}
	devices, err := template.Device(ctx)
	if err != nil {
		return nil, classify(err)
	}
	var changes []types.BaseVirtualDeviceConfigSpec
	if nics := devices.SelectByType((*types.VirtualEthernetCard)(nil)); len(nics) > 0 {
		backing, err := networkBacking(ctx, c, r.Network)
		if err != nil {
			return nil, &Failure{Code: "NETWORK_NOT_FOUND", Message: "network not found"}
		}
		nic := nics[0].(types.BaseVirtualEthernetCard).GetVirtualEthernetCard()
		nic.Backing = backing
		changes = append(changes, &types.VirtualDeviceConfigSpec{Operation: types.VirtualDeviceConfigSpecOperationEdit, Device: nics[0]})
	} else {
		return nil, &Failure{Code: "TEMPLATE_HAS_NO_NIC", Message: "the template needs a network adapter"}
	}
	if disks := devices.SelectByType((*types.VirtualDisk)(nil)); len(disks) > 0 {
		disk := disks[0].(*types.VirtualDisk)
		if want := r.DiskGB * 1024 * 1024; want > disk.CapacityInKB {
			disk.CapacityInKB, disk.CapacityInBytes = want, want*1024
			changes = append(changes, &types.VirtualDeviceConfigSpec{Operation: types.VirtualDeviceConfigSpecOperationEdit, Device: disk})
		} else if want < disk.CapacityInKB {
			return nil, &Failure{Code: "DISK_SMALLER_THAN_TEMPLATE", Message: "requested disk is smaller than the template disk"}
		}
	}
	pool := types.ManagedObjectReference{Type: "ResourcePool", Value: r.Pool}
	ds := types.ManagedObjectReference{Type: "Datastore", Value: r.Datastore}
	config, customization := cloneConfig(r, tpl.Config)
	spec := types.VirtualMachineCloneSpec{
		Location:      types.VirtualMachineRelocateSpec{Pool: &pool, Datastore: &ds, DeviceChange: changes},
		PowerOn:       false,
		Config:        config,
		Customization: customization,
	}
	task, err := template.Clone(ctx, object.NewFolder(c, *tpl.Parent), r.Name, spec)
	if err != nil {
		return nil, classify(err)
	}
	return map[string]any{"task": task.Reference().Value, "existed": false}, nil
}

// cloneConfig is the new VM's configuration: size, hardware options, the server id, and how the guest is set
// up (vCenter's cloud-init, cloud-init through guestinfo, or an appliance's vApp properties).
func cloneConfig(r CloneRequest, tpl *types.VirtualMachineConfigInfo) (*types.VirtualMachineConfigSpec, *types.CustomizationSpec) {
	config := &types.VirtualMachineConfigSpec{NumCPUs: r.VCPU, MemoryMB: r.MemoryMB,
		Annotation:          "Managed by Lightning VM (server " + r.ServerID + ")",
		CpuHotAddEnabled:    types.NewBool(r.CPUHotAdd),
		MemoryHotAddEnabled: types.NewBool(r.MemoryHotAdd),
		NestedHVEnabled:     types.NewBool(r.NestedHV)}
	extra := []types.BaseOptionValue{&types.OptionValue{Key: "lightning.server-id", Value: r.ServerID}}
	var customization *types.CustomizationSpec
	switch r.Customization {
	case "appliance":
		var props []types.VAppPropertySpec
		if tpl != nil && tpl.VAppConfig != nil {
			for _, p := range tpl.VAppConfig.GetVmConfigInfo().Property {
				if v, ok := r.VAppProperties[p.Id]; ok {
					props = append(props, types.VAppPropertySpec{ArrayUpdateSpec: types.ArrayUpdateSpec{Operation: types.ArrayUpdateOperationEdit},
						Info: &types.VAppPropertyInfo{Key: p.Key, Id: p.Id, Value: v}})
				}
			}
		}
		if len(props) > 0 {
			config.VAppConfig = &types.VmConfigSpec{Property: props}
		}
		keys := make([]string, 0, len(r.VAppProperties))
		for k := range r.VAppProperties {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if strings.HasPrefix(k, "guestinfo.") {
				extra = append(extra, &types.OptionValue{Key: k, Value: r.VAppProperties[k]})
			}
		}
	case "guestinfo":
		b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
		extra = append(extra,
			&types.OptionValue{Key: "guestinfo.metadata", Value: b64(r.Metadata)}, &types.OptionValue{Key: "guestinfo.metadata.encoding", Value: "base64"},
			&types.OptionValue{Key: "guestinfo.userdata", Value: b64(r.Userdata)}, &types.OptionValue{Key: "guestinfo.userdata.encoding", Value: "base64"})
	default:
		customization = &types.CustomizationSpec{
			Identity:         &types.CustomizationCloudinitPrep{Metadata: r.Metadata, Userdata: r.Userdata},
			GlobalIPSettings: types.CustomizationGlobalIPSettings{},
		}
	}
	config.ExtraConfig = extra
	return config, customization
}

func taskFault(f *types.LocalizedMethodFault) (string, string) {
	if f == nil {
		return "TASK_FAILED", ""
	}
	msg := f.LocalizedMessage
	switch f.Fault.(type) {
	case *types.RestrictedVersion:
		return "WRITE_RESTRICTED", msg
	case *types.NoPermission:
		return "PERMISSION_DENIED", msg
	case *types.InsufficientResourcesFault, *types.NotEnoughLicenses:
		return "INSUFFICIENT_RESOURCES", msg
	case *types.DuplicateName:
		return "DUPLICATE_NAME", msg
	case *types.InvalidState, *types.InvalidPowerState:
		return "INVALID_STATE", msg
	}
	return "TASK_FAILED", msg
}

func taskState(ctx context.Context, c *vim25.Client, moref string) (*TaskState, error) {
	var t mo.Task
	err := property.DefaultCollector(c).RetrieveOne(ctx, types.ManagedObjectReference{Type: "Task", Value: moref}, []string{"info"}, &t)
	if err != nil {
		if fault.Is(err, &types.ManagedObjectNotFound{}) {
			// Tasks expire from vCenter's memory; the caller then looks the VM up by name.
			return &TaskState{State: "unknown", Code: "TASK_NOT_FOUND"}, nil
		}
		return nil, err
	}
	s := &TaskState{State: string(t.Info.State)}
	if ref, ok := t.Info.Result.(types.ManagedObjectReference); ok {
		s.VM = ref.Value
	}
	if t.Info.State == types.TaskInfoStateError {
		s.Code, s.Error = taskFault(t.Info.Error)
	}
	return s, nil
}

type VMRequest struct {
	Request
	VM     string `json:"vm"`
	Name   string `json:"name"`
	Task   string `json:"task"`
	Action string `json:"action"`
}

func withClient(ctx context.Context, g *netGuard, r Request, work func(*vim25.Client) (any, error)) (any, error) {
	c, sm, err := connect(ctx, g, r)
	if err != nil {
		return nil, err
	}
	defer sm.Logout(context.WithoutCancel(ctx))
	out, err := work(c)
	if err != nil {
		return nil, classify(err)
	}
	return out, nil
}

// powerAction starts on/off/reset as a task; a guest shutdown has no task and needs VMware Tools.
func powerAction(ctx context.Context, c *vim25.Client, r VMRequest) (any, error) {
	vm := object.NewVirtualMachine(c, types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM})
	var task *object.Task
	var err error
	switch r.Action {
	case "on":
		task, err = vm.PowerOn(ctx)
	case "off":
		task, err = vm.PowerOff(ctx)
	case "reset":
		task, err = vm.Reset(ctx)
	case "shutdown":
		var v mo.VirtualMachine
		if err := vm.Properties(ctx, vm.Reference(), []string{"guest.toolsRunningStatus"}, &v); err != nil {
			return nil, err
		}
		if v.Guest == nil || v.Guest.ToolsRunningStatus != string(types.VirtualMachineToolsRunningStatusGuestToolsRunning) {
			return nil, &Failure{Code: "TOOLS_NOT_RUNNING", Message: "a clean shutdown needs VMware Tools in the guest"}
		}
		return map[string]any{"task": ""}, vm.ShutdownGuest(ctx)
	default:
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "action must be on, off, reset or shutdown"}
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}

// destroyVM powers the VM off if needed, then starts Destroy_Task. Only VMs this platform named are touched.
func destroyVM(ctx context.Context, c *vim25.Client, r VMRequest) (any, error) {
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM}
	vm := object.NewVirtualMachine(c, ref)
	var v mo.VirtualMachine
	if err := vm.Properties(ctx, ref, []string{"name", "runtime.powerState"}, &v); err != nil {
		if fault.Is(err, &types.ManagedObjectNotFound{}) {
			return map[string]any{"task": "", "gone": true}, nil
		}
		return nil, err
	}
	if !strings.HasPrefix(v.Name, managedPrefix) {
		return nil, &Failure{Code: "NOT_MANAGED", Message: "refusing to delete a VM this platform did not create"}
	}
	if v.Runtime.PowerState == types.VirtualMachinePowerStatePoweredOn {
		t, err := vm.PowerOff(ctx)
		if err != nil {
			return nil, err
		}
		if err := t.Wait(ctx); err != nil && !fault.Is(err, &types.InvalidPowerState{}) {
			return nil, err
		}
	}
	t, err := vm.Destroy(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": t.Reference().Value}, nil
}
