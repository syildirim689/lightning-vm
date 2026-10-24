package main

// TEST ONLY: vcsim never starts VMware Tools in a cloned VM. This plays the guest agent of a
// template with open-vm-tools installed: Tools run while the VM is powered on, and stop when it is off.

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/lightning-vm/lightning-vm/services/vmware/simfw"
	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25/types"
)

func simulateGuestTools(model *simulator.Model) {
	r := model.Map()
	ctx := &simulator.Context{Context: context.Background(), Map: r,
		Session: &simulator.Session{UserSession: types.UserSession{Key: uuid.New().String()}, Registry: simulator.NewRegistry(), Map: r}}
	for range time.Tick(500 * time.Millisecond) {
		for _, e := range r.All("VirtualMachine") {
			vm, ok := e.(*simulator.VirtualMachine)
			if w, wrapped := e.(*ticketVM); wrapped {
				vm, ok = w.VirtualMachine, true
			}
			if !ok {
				continue
			}
			ctx.WithLock(e, func() {
				simfw.AssignPorts(vm) // static port binding, so firewalls can be applied
				want, status := types.VirtualMachineToolsRunningStatusGuestToolsNotRunning, types.VirtualMachineToolsStatusToolsNotRunning
				if vm.Runtime.PowerState == types.VirtualMachinePowerStatePoweredOn {
					want, status = types.VirtualMachineToolsRunningStatusGuestToolsRunning, types.VirtualMachineToolsStatusToolsOk
				}
				if vm.Config.Template || vm.Guest == nil || vm.Guest.ToolsRunningStatus == string(want) {
					return
				}
				ctx.Update(e, []types.PropertyChange{{Name: "guest.toolsRunningStatus", Val: string(want)}, {Name: "guest.toolsStatus", Val: status}})
			})
		}
	}
}
