package main

import (
	"context"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// ShapingRequest: a speed limit on the VM's distributed ports, both directions (Mbit/s; 0 removes it and the port
// follows its port group again). Used when a server has used up its monthly traffic.
type ShapingRequest struct {
	Request
	VM   string `json:"vm"`
	Mbps int64  `json:"mbps"`
}

func shapingPolicy(mbps int64) *types.DVSTrafficShapingPolicy {
	if mbps <= 0 {
		return &types.DVSTrafficShapingPolicy{InheritablePolicy: types.InheritablePolicy{Inherited: true}}
	}
	bits := mbps * 1_000_000
	fixed := types.InheritablePolicy{Inherited: false}
	return &types.DVSTrafficShapingPolicy{InheritablePolicy: fixed,
		Enabled:          &types.BoolPolicy{InheritablePolicy: fixed, Value: types.NewBool(true)},
		AverageBandwidth: &types.LongPolicy{InheritablePolicy: fixed, Value: bits},
		PeakBandwidth:    &types.LongPolicy{InheritablePolicy: fixed, Value: bits},
		BurstSize:        &types.LongPolicy{InheritablePolicy: fixed, Value: bits / 8}} // one second at the limit
}

func applyShaping(ctx context.Context, c *vim25.Client, r ShapingRequest) (any, error) {
	ports, err := vmPorts(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	if err := allowShapingOverride(ctx, c, r.VM); err != nil {
		return nil, err
	}
	for _, p := range ports {
		dvs := object.NewDistributedVirtualSwitch(c, p.dvs)
		current, err := dvs.FetchDVPorts(ctx, &types.DistributedVirtualSwitchPortCriteria{PortKey: []string{p.key}})
		if err != nil {
			return nil, err
		}
		if len(current) == 0 {
			return nil, &Failure{Code: "FIREWALL_NO_PORT", Message: "distributed port " + p.key + " not found"}
		}
		policy := shapingPolicy(r.Mbps)
		task, err := dvs.ReconfigureDVPort(ctx, []types.DVPortConfigSpec{{Operation: "edit", Key: p.key, ConfigVersion: current[0].Config.ConfigVersion,
			Setting: &types.VMwareDVSPortSetting{DVPortSetting: types.DVPortSetting{InShapingPolicy: policy, OutShapingPolicy: policy}}}})
		if err != nil {
			return nil, err
		}
		if _, err := task.WaitForResult(ctx); err != nil {
			code, msg := taskFault(asFault(err))
			return nil, &Failure{Code: code, Message: msg}
		}
	}
	return map[string]any{"ports": len(ports), "mbps": r.Mbps}, nil
}

// Like the traffic filter, a port's own speed limit needs its port group to allow overriding the shaping policy.
func allowShapingOverride(ctx context.Context, c *vim25.Client, moref string) error {
	var vm mo.VirtualMachine
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: moref}
	if err := object.NewVirtualMachine(c, ref).Properties(ctx, ref, []string{"network"}, &vm); err != nil {
		return err
	}
	for _, n := range vm.Network {
		if n.Type != "DistributedVirtualPortgroup" {
			continue
		}
		pg := object.NewDistributedVirtualPortgroup(c, n)
		var cfg mo.DistributedVirtualPortgroup
		if err := pg.Properties(ctx, n, []string{"config.policy", "config.configVersion"}, &cfg); err != nil {
			return err
		}
		policy := cfg.Config.Policy
		if policy == nil {
			policy = &types.VMwareDVSPortgroupPolicy{}
		}
		p := policy.GetDVPortgroupPolicy()
		if p.ShapingOverrideAllowed {
			continue
		}
		p.ShapingOverrideAllowed = true
		task, err := pg.Reconfigure(ctx, types.DVPortgroupConfigSpec{ConfigVersion: cfg.Config.ConfigVersion, Policy: policy})
		if err != nil {
			return err
		}
		if _, err := task.WaitForResult(ctx); err != nil {
			code, msg := taskFault(asFault(err))
			return &Failure{Code: code, Message: msg}
		}
	}
	return nil
}
