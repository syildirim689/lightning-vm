// TEST ONLY: a simulated vCenter or standalone ESXi built on govmomi's simulator package (the
// engine behind vcsim), pinned by this module's go.sum. Not part of the adapter image.
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net"
	"net/url"
	"sort"

	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25/types"
)

func main() {
	addr := flag.String("l", "0.0.0.0:8989", "listen address")
	esx := flag.Bool("esx", false, "simulate a standalone ESXi instead of vCenter")
	user := flag.String("username", "user", "accepted user name")
	pass := flag.String("password", "pass", "accepted password")
	clusters := flag.Int("cluster", 1, "clusters (vCenter only)")
	hosts := flag.Int("host", 1, "standalone hosts (vCenter only)")
	clusterHosts := flag.Int("cluster-host", 1, "hosts per cluster (vCenter only)")
	webmks := flag.String("webmks", "", "TEST ONLY: host:port for a fake WebMKS endpoint returned by AcquireTicket")
	// vcsim reports API 6.5 by default; its cloud-init customization is what a 7.0U3+ vCenter does, so the
	// simulated vCenter presents itself as 8.0 U3 (the adapter picks the customization method from this).
	apiVersion := flag.String("api-version", "8.0.3.0", "API version reported in ServiceContent.About")
	flag.Parse()

	model := simulator.VPX()
	if *esx {
		model = simulator.ESX()
	} else {
		model.Cluster, model.Host, model.ClusterHost = *clusters, *hosts, *clusterHosts
	}
	if !*esx && *apiVersion != "" {
		model.ServiceContent.About.ApiVersion = *apiVersion
	}
	if err := model.Create(); err != nil {
		log.Fatal(err)
	}
	// A vCenter normally has templates to deploy from; turn the first VM into one (powered off).
	if !*esx {
		vms := model.Map().All("VirtualMachine")
		sort.Slice(vms, func(i, j int) bool { return vms[i].Entity().Name < vms[j].Entity().Name })
		vm := vms[0].(*simulator.VirtualMachine)
		vm.Config.Template, vm.Summary.Config.Template = true, true
		vm.Runtime.PowerState, vm.Summary.Runtime.PowerState = types.VirtualMachinePowerStatePoweredOff, types.VirtualMachinePowerStatePoweredOff
	}
	if *webmks != "" {
		host, port, err := net.SplitHostPort(*webmks)
		if err != nil {
			log.Fatal(err)
		}
		enableWebMKS(model, host, port)
	}
	// Credentials in the listen URL make the simulator reject any other user name or password.
	model.Service.Listen = &url.URL{Host: *addr, User: url.UserPassword(*user, *pass)}
	model.Service.TLS = new(tls.Config) // self-signed certificate generated at start
	s := model.Service.NewServer()
	go simulateGuestTools(model)
	log.Printf("simulator listening on %s (esx=%v)", s.URL.Host, *esx)
	select {}
}
