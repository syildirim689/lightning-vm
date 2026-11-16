package main

import (
	"context"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/task"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Hetzner-style firewalls enforced by the vSphere Distributed Switch: a traffic-filter ruleset on each
// distributed port the VM's NICs use. The hypervisor applies it, so the guest cannot turn it off.
//
// vDS filters are stateless and first-match by sequence, so the ruleset adds what a stateful firewall
// does implicitly: replies to connections the VM opened (TCP/UDP to ephemeral ports 32768-65535),
// replies of the services it allows in (from their source ports), and IPv6 neighbour discovery.
// With any inbound rule list everything else coming in is dropped; outgoing traffic is dropped only
// when outbound rules exist (Hetzner's semantics).

type FirewallRule struct {
	Direction string   `json:"direction"` // "in" or "out", from the VM's point of view
	Protocol  string   `json:"protocol"`  // tcp, udp, icmp, esp, gre
	Port      string   `json:"port"`      // tcp/udp only: "443" or "8000-8100"
	IPs       []string `json:"ips"`       // CIDRs: sources for "in", destinations for "out"
}

type FirewallRequest struct {
	Request
	VM      string         `json:"vm"`
	Enabled bool           `json:"enabled"` // false removes the filter (no firewall attached any more)
	Rules   []FirewallRule `json:"rules"`
}

// vDS directions are the switch's view: "incomingPackets" enter the switch from the VM (the VM's
// outbound traffic), "outgoingPackets" leave the switch towards the VM (its inbound traffic).
// shortcut: taken from the vSphere networking guide's ingress/egress definition, verify on a real vCenter.
const (
	toVM   = string(types.DvsNetworkRuleDirectionTypeOutgoingPackets)
	fromVM = string(types.DvsNetworkRuleDirectionTypeIncomingPackets)
)

const filterAgent = "dvfilter-generic-vmware"
const maxGeneratedRules = 500

var protocols = map[string]int32{"icmp": 1, "tcp": 6, "udp": 17, "gre": 47, "esp": 50}

const icmpv6 = 58

func portExpr(port string) (types.BaseDvsIpPort, error) {
	if port == "" {
		return nil, nil
	}
	lo, hi, isRange := strings.Cut(port, "-")
	a, err1 := strconv.Atoi(lo)
	b := a
	var err2 error
	if isRange {
		b, err2 = strconv.Atoi(hi)
	}
	if err1 != nil || err2 != nil || a < 1 || b > 65535 || a > b {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "invalid port " + port}
	}
	if a == b {
		return &types.DvsSingleIpPort{PortNumber: int32(a)}, nil
	}
	return &types.DvsIpPortRange{StartPortNumber: int32(a), EndPortNumber: int32(b)}, nil
}

// addresses turns CIDRs into vDS address qualifiers; nil means "any". 0.0.0.0/0 and ::/0 both become
// "any" (vDS has no "any IPv4 only"), which only matters for VMs that also have IPv6.
func addresses(cidrs []string) ([]types.BaseIpAddress, error) {
	var out []types.BaseIpAddress
	for _, c := range cidrs {
		p, err := netip.ParsePrefix(strings.TrimSpace(c))
		if err != nil {
			return nil, &Failure{Code: "INVALID_REQUEST", Message: "invalid network " + c}
		}
		if p.Bits() == 0 {
			return []types.BaseIpAddress{nil}, nil
		}
		out = append(out, &types.IpRange{AddressPrefix: p.Masked().Addr().String(), PrefixLength: int32(p.Bits())})
	}
	if len(out) == 0 {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "a rule needs at least one network"}
	}
	return out, nil
}

// buildRuleset is the whole translation; it touches no VMware object, so it is tested directly.
func buildRuleset(rules []FirewallRule) (*types.DvsTrafficRuleset, error) {
	var out []types.DvsTrafficRule
	add := func(dir, desc string, accept bool, q *types.DvsIpNetworkRuleQualifier) {
		var action types.BaseDvsNetworkRuleAction = &types.DvsDropNetworkRuleAction{}
		if accept {
			action = &types.DvsAcceptNetworkRuleAction{}
		}
		out = append(out, types.DvsTrafficRule{Description: desc, Sequence: int32(len(out) + 1), Direction: dir,
			Qualifier: []types.BaseDvsNetworkRuleQualifier{q}, Action: action})
	}
	proto := func(p int32) *types.IntExpression { return &types.IntExpression{Value: p} }
	hasOut := false
	for _, r := range rules {
		if r.Direction == "out" {
			hasOut = true
		}
	}
	for _, dir := range []string{"in", "out"} {
		if dir == "out" && !hasOut {
			break
		}
		vdsDir := map[string]string{"in": toVM, "out": fromVM}[dir]
		for i, r := range rules {
			if r.Direction != dir {
				continue
			}
			p, ok := protocols[r.Protocol]
			if !ok {
				return nil, &Failure{Code: "INVALID_REQUEST", Message: "unknown protocol " + r.Protocol}
			}
			port, err := portExpr(r.Port)
			if err != nil {
				return nil, err
			}
			ips, err := addresses(r.IPs)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				q := &types.DvsIpNetworkRuleQualifier{Protocol: proto(p), DestinationIpPort: port}
				if dir == "in" {
					q.SourceAddress = ip
				} else {
					q.DestinationAddress = ip
				}
				add(vdsDir, fmt.Sprintf("rule %d", i+1), true, q)
			}
		}
		if dir == "in" {
			// Replies to connections the VM opened (Linux and Windows ephemeral ports), and IPv6 neighbour discovery.
			for _, p := range []int32{6, 17} {
				add(toVM, "auto: replies to outgoing connections", true, &types.DvsIpNetworkRuleQualifier{Protocol: proto(p),
					DestinationIpPort: &types.DvsIpPortRange{StartPortNumber: 32768, EndPortNumber: 65535}})
			}
			add(toVM, "auto: IPv6 neighbour discovery", true, &types.DvsIpNetworkRuleQualifier{Protocol: proto(icmpv6)})
			add(toVM, "auto: drop everything else", false, &types.DvsIpNetworkRuleQualifier{})
			continue
		}
		// Outbound is restricted: let the allowed inbound services answer, then drop the rest.
		for i, r := range rules {
			if r.Direction != "in" {
				continue
			}
			q := &types.DvsIpNetworkRuleQualifier{Protocol: proto(protocols[r.Protocol])}
			if r.Protocol == "tcp" || r.Protocol == "udp" {
				q.SourceIpPort, _ = portExpr(r.Port)
			}
			add(fromVM, fmt.Sprintf("auto: replies of rule %d", i+1), true, q)
		}
		add(fromVM, "auto: IPv6 neighbour discovery", true, &types.DvsIpNetworkRuleQualifier{Protocol: proto(icmpv6)})
		add(fromVM, "auto: drop everything else", false, &types.DvsIpNetworkRuleQualifier{})
	}
	if len(out) > maxGeneratedRules {
		return nil, &Failure{Code: "FIREWALL_TOO_MANY_RULES", Message: fmt.Sprintf("%d filter rules; at most %d", len(out), maxGeneratedRules)}
	}
	enabled := true
	return &types.DvsTrafficRuleset{Enabled: &enabled, Rules: out}, nil
}

type dvPort struct {
	dvs types.ManagedObjectReference
	key string
}

// vmPorts lists the distributed ports of the VM's NICs. Every NIC must be on a distributed switch with a
// port assigned (static binding); otherwise traffic could bypass the firewall.
func vmPorts(ctx context.Context, c *vim25.Client, moref string) ([]dvPort, error) {
	var vm mo.VirtualMachine
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: moref}
	if err := object.NewVirtualMachine(c, ref).Properties(ctx, ref, []string{"config.hardware.device", "network"}, &vm); err != nil {
		return nil, err
	}
	switchOf := map[string]types.ManagedObjectReference{} // portgroup key -> switch
	for _, n := range vm.Network {
		if n.Type != "DistributedVirtualPortgroup" {
			continue
		}
		var pg mo.DistributedVirtualPortgroup
		obj := object.NewDistributedVirtualPortgroup(c, n)
		if err := obj.Properties(ctx, n, []string{"key", "config.distributedVirtualSwitch", "config.policy", "config.configVersion"}, &pg); err != nil {
			return nil, err
		}
		if pg.Config.DistributedVirtualSwitch != nil {
			switchOf[pg.Key] = *pg.Config.DistributedVirtualSwitch
		}
		if err := allowFilterOverride(ctx, obj, pg.Config); err != nil {
			return nil, err
		}
	}
	devices, err := vmDevices(vm)
	if err != nil {
		return nil, err
	}
	var ports []dvPort
	for _, d := range devices.SelectByType((*types.VirtualEthernetCard)(nil)) {
		b, ok := d.GetVirtualDevice().Backing.(*types.VirtualEthernetCardDistributedVirtualPortBackingInfo)
		if !ok {
			return nil, &Failure{Code: "FIREWALL_NEEDS_DVS", Message: "a network card is not on a distributed switch"}
		}
		if b.Port.PortKey == "" || switchOf[b.Port.PortgroupKey].Value == "" {
			return nil, &Failure{Code: "FIREWALL_NO_PORT", Message: "the network card has no distributed port (use static port binding)"}
		}
		ports = append(ports, dvPort{dvs: switchOf[b.Port.PortgroupKey], key: b.Port.PortKey})
	}
	return ports, nil
}

// A port can carry its own traffic filter only if its port group allows overriding that policy. The
// platform owns the port groups of its locations, so it turns this on itself (needs DVPortgroup.PolicyOp).
// Only the policy is sent: vCenter leaves every unset field of the spec as it is.
func allowFilterOverride(ctx context.Context, pg *object.DistributedVirtualPortgroup, cfg types.DVPortgroupConfigInfo) error {
	policy := cfg.Policy
	if policy == nil {
		policy = &types.VMwareDVSPortgroupPolicy{}
	}
	if p := policy.GetDVPortgroupPolicy(); p.TrafficFilterOverrideAllowed != nil && *p.TrafficFilterOverrideAllowed {
		return nil
	}
	allowed := true
	policy.GetDVPortgroupPolicy().TrafficFilterOverrideAllowed = &allowed
	task, err := pg.Reconfigure(ctx, types.DVPortgroupConfigSpec{ConfigVersion: cfg.ConfigVersion, Policy: policy})
	if err != nil {
		return err
	}
	if _, err := task.WaitForResult(ctx); err != nil {
		if code, msg := taskFault(asFault(err)); code != "TASK_FAILED" {
			return &Failure{Code: code, Message: msg}
		}
		return &Failure{Code: "FIREWALL_APPLY_FAILED", Message: "allowing traffic-filter override on the port group: " + err.Error()}
	}
	return nil
}

func applyFirewall(ctx context.Context, c *vim25.Client, r FirewallRequest) (any, error) {
	var ruleset *types.DvsTrafficRuleset
	if r.Enabled {
		var err error
		if ruleset, err = buildRuleset(r.Rules); err != nil {
			return nil, err
		}
	}
	ports, err := vmPorts(ctx, c, r.VM)
	if err != nil {
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
		// Edit our filter if the port already has one, add it otherwise; remove it when disabled.
		op, key := "add", ""
		if s := current[0].Config.Setting; s != nil && s.GetDVPortSetting().FilterPolicy != nil {
			for _, f := range s.GetDVPortSetting().FilterPolicy.FilterConfig {
				if tf, ok := f.(*types.DvsTrafficFilterConfig); ok && tf.AgentName == filterAgent {
					op, key = "edit", tf.Key
				}
			}
		}
		if ruleset == nil {
			if op == "add" {
				continue // nothing to remove
			}
			op = "remove"
		}
		spec := &types.DvsTrafficFilterConfigSpec{Operation: op, DvsTrafficFilterConfig: types.DvsTrafficFilterConfig{
			DvsFilterConfig: types.DvsFilterConfig{InheritablePolicy: types.InheritablePolicy{Inherited: false}, Key: key, AgentName: filterAgent},
			TrafficRuleset:  ruleset}}
		task, err := dvs.ReconfigureDVPort(ctx, []types.DVPortConfigSpec{{Operation: "edit", Key: p.key, ConfigVersion: current[0].Config.ConfigVersion,
			Setting: &types.VMwareDVSPortSetting{DVPortSetting: types.DVPortSetting{FilterPolicy: &types.DvsFilterPolicy{
				InheritablePolicy: types.InheritablePolicy{Inherited: false}, FilterConfig: []types.BaseDvsFilterConfig{spec}}}}}})
		if err != nil {
			return nil, err
		}
		if _, err := task.WaitForResult(ctx); err != nil {
			if code, msg := taskFault(asFault(err)); code != "TASK_FAILED" {
				return nil, &Failure{Code: code, Message: msg}
			}
			return nil, &Failure{Code: "FIREWALL_APPLY_FAILED", Message: err.Error()}
		}
	}
	return map[string]any{"ports": len(ports), "rules": ruleCount(ruleset)}, nil
}

func ruleCount(r *types.DvsTrafficRuleset) int {
	if r == nil {
		return 0
	}
	return len(r.Rules)
}

func asFault(err error) *types.LocalizedMethodFault {
	if te, ok := err.(task.Error); ok {
		return te.LocalizedMethodFault
	}
	return nil
}
