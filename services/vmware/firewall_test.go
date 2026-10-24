package main

import (
	"context"
	"testing"

	"github.com/lightning-vm/lightning-vm/services/vmware/simfw"
	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

func TestRulesetInboundOnly(t *testing.T) {
	rs, err := buildRuleset([]FirewallRule{
		{Direction: "in", Protocol: "tcp", Port: "22", IPs: []string{"0.0.0.0/0", "::/0"}},
		{Direction: "in", Protocol: "tcp", Port: "8000-8100", IPs: []string{"203.0.113.0/24", "198.51.100.7/32"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// ssh (any source: one rule), two sources for 8000-8100, tcp+udp replies, ICMPv6, drop.
	if len(rs.Rules) != 7 {
		t.Fatalf("want 7 rules, got %d", len(rs.Rules))
	}
	for i, r := range rs.Rules {
		if r.Direction != toVM || r.Sequence != int32(i+1) {
			t.Fatalf("rule %d: direction %s sequence %d", i, r.Direction, r.Sequence)
		}
	}
	ssh := rs.Rules[0].Qualifier[0].(*types.DvsIpNetworkRuleQualifier)
	if ssh.Protocol.Value != 6 || ssh.SourceAddress != nil || ssh.DestinationIpPort.(*types.DvsSingleIpPort).PortNumber != 22 {
		t.Fatalf("ssh rule wrong: %+v", ssh)
	}
	r2 := rs.Rules[2].Qualifier[0].(*types.DvsIpNetworkRuleQualifier)
	if a := r2.SourceAddress.(*types.IpRange); a.AddressPrefix != "198.51.100.7" || a.PrefixLength != 32 {
		t.Fatalf("source wrong: %+v", a)
	}
	if pr := rs.Rules[1].Qualifier[0].(*types.DvsIpNetworkRuleQualifier).DestinationIpPort.(*types.DvsIpPortRange); pr.StartPortNumber != 8000 || pr.EndPortNumber != 8100 {
		t.Fatalf("range wrong: %+v", pr)
	}
	if _, drop := rs.Rules[6].Action.(*types.DvsDropNetworkRuleAction); !drop {
		t.Fatal("last rule must drop")
	}
}

func TestRulesetWithOutbound(t *testing.T) {
	rs, err := buildRuleset([]FirewallRule{
		{Direction: "in", Protocol: "tcp", Port: "443", IPs: []string{"0.0.0.0/0"}},
		{Direction: "out", Protocol: "udp", Port: "53", IPs: []string{"9.9.9.9/32"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var out []types.DvsTrafficRule
	for _, r := range rs.Rules {
		if r.Direction == fromVM {
			out = append(out, r)
		}
	}
	// DNS out, reply of the https rule, ICMPv6, drop.
	if len(out) != 4 {
		t.Fatalf("want 4 outbound rules, got %d", len(out))
	}
	if q := out[1].Qualifier[0].(*types.DvsIpNetworkRuleQualifier); q.SourceIpPort.(*types.DvsSingleIpPort).PortNumber != 443 {
		t.Fatalf("https replies must leave from port 443: %+v", q)
	}
	if _, drop := out[3].Action.(*types.DvsDropNetworkRuleAction); !drop {
		t.Fatal("outbound must end with drop")
	}
}

func TestRulesetRejectsBadInput(t *testing.T) {
	for _, r := range []FirewallRule{
		{Direction: "in", Protocol: "sctp", IPs: []string{"0.0.0.0/0"}},
		{Direction: "in", Protocol: "tcp", Port: "70000", IPs: []string{"0.0.0.0/0"}},
		{Direction: "in", Protocol: "tcp", Port: "90-80", IPs: []string{"0.0.0.0/0"}},
		{Direction: "in", Protocol: "tcp", Port: "22", IPs: []string{"10.0.0.300/8"}},
		{Direction: "in", Protocol: "tcp", Port: "22"},
	} {
		if _, err := buildRuleset([]FirewallRule{r}); err == nil || err.(*Failure).Code != "INVALID_REQUEST" {
			t.Fatalf("%+v: want INVALID_REQUEST, got %v", r, err)
		}
	}
}

func TestApplyFirewallOnDistributedPort(t *testing.T) {
	model := simulator.VPX()
	host, port, srv := startSim(t, model)
	switches := simfw.Enable(model)
	ctx := context.Background()
	c, sm, err := connect(ctx, testGuard(), Request{Host: host, Port: port, Username: "user", Password: "pass", TLS: TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)}})
	if err != nil {
		t.Fatal(err)
	}
	defer sm.Logout(ctx)

	vms, _ := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"name"})
	pgs, _ := retrieve[mo.DistributedVirtualPortgroup](ctx, c, "DistributedVirtualPortgroup", []string{"name", "config.uplink"})
	var pg types.ManagedObjectReference
	for _, p := range pgs {
		if p.Config.Uplink == nil || !*p.Config.Uplink {
			pg = p.Self
		}
	}
	vm := object.NewVirtualMachine(c, vms[0].Self)

	devices, _ := vm.Device(ctx)
	nic := devices.SelectByType((*types.VirtualEthernetCard)(nil))[0]
	nets, _ := retrieve[mo.Network](ctx, c, "Network", []string{"name"})
	std, _ := object.NewNetwork(c, nets[0].Self).EthernetCardBackingInfo(ctx)
	nic.GetVirtualDevice().Backing = std
	if err := vm.EditDevice(ctx, nic); err != nil {
		t.Fatal(err)
	}
	in := []FirewallRule{{Direction: "in", Protocol: "icmp", IPs: []string{"0.0.0.0/0"}}}
	// On a standard switch the firewall cannot be enforced, and says so.
	if _, err := applyFirewall(ctx, c, FirewallRequest{VM: vm.Reference().Value, Enabled: true, Rules: in}); err == nil || err.(*Failure).Code != "FIREWALL_NEEDS_DVS" {
		t.Fatalf("want FIREWALL_NEEDS_DVS, got %v", err)
	}
	backing, _ := object.NewDistributedVirtualPortgroup(c, pg).EthernetCardBackingInfo(ctx)
	nic.GetVirtualDevice().Backing = backing
	if err := vm.EditDevice(ctx, nic); err != nil {
		t.Fatal(err)
	}
	// A distributed NIC without a port (ephemeral binding) is refused too.
	if _, err := applyFirewall(ctx, c, FirewallRequest{VM: vm.Reference().Value, Enabled: true, Rules: in}); err == nil || err.(*Failure).Code != "FIREWALL_NO_PORT" {
		t.Fatalf("want FIREWALL_NO_PORT, got %v", err)
	}
	simfw.AssignPorts(model.Map().Get(vm.Reference()).(*simulator.VirtualMachine))
	devices, _ = vm.Device(ctx)
	key := devices.SelectByType((*types.VirtualEthernetCard)(nil))[0].GetVirtualDevice().Backing.(*types.VirtualEthernetCardDistributedVirtualPortBackingInfo).Port.PortKey

	rules := []FirewallRule{{Direction: "in", Protocol: "tcp", Port: "22", IPs: []string{"0.0.0.0/0"}}, {Direction: "in", Protocol: "icmp", IPs: []string{"0.0.0.0/0"}}}
	if _, err := applyFirewall(ctx, c, FirewallRequest{VM: vm.Reference().Value, Enabled: true, Rules: rules}); err != nil {
		t.Fatal(err)
	}
	if got := switches.Filter(key); got == nil || len(got.Rules) != 6 {
		t.Fatalf("want 6 rules on port %s, got %+v", key, got)
	}
	// The port group now allows per-port filters, and nothing else about it changed.
	var after mo.DistributedVirtualPortgroup
	if err := object.NewDistributedVirtualPortgroup(c, pg).Properties(ctx, pg, []string{"name", "config.policy"}, &after); err != nil {
		t.Fatal(err)
	}
	if p := after.Config.Policy.GetDVPortgroupPolicy().TrafficFilterOverrideAllowed; p == nil || !*p || after.Name == "" {
		t.Fatalf("port group policy not updated as expected: %+v name=%q", after.Config.Policy, after.Name)
	}
	// Changing the rules edits the same filter.
	if _, err := applyFirewall(ctx, c, FirewallRequest{VM: vm.Reference().Value, Enabled: true, Rules: rules[:1]}); err != nil {
		t.Fatal(err)
	}
	if got := switches.Filter(key); got == nil || len(got.Rules) != 5 {
		t.Fatalf("want 5 rules after edit, got %+v", got)
	}
	// Detaching every firewall removes the filter; doing it twice is harmless.
	for i := 0; i < 2; i++ {
		if _, err := applyFirewall(ctx, c, FirewallRequest{VM: vm.Reference().Value, Enabled: false}); err != nil {
			t.Fatal(err)
		}
	}
	if got := switches.Filter(key); got != nil {
		t.Fatalf("filter must be gone, got %+v", got)
	}
}
