// TEST ONLY: a simulated vCenter or standalone ESXi built on govmomi's simulator package (the
// engine behind vcsim), pinned by this module's go.sum. Not part of the adapter image.
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net"
	"net/url"

	"github.com/vmware/govmomi/simulator"
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
	flag.Parse()

	model := simulator.VPX()
	if *esx {
		model = simulator.ESX()
	} else {
		model.Cluster, model.Host, model.ClusterHost = *clusters, *hosts, *clusterHosts
	}
	if err := model.Create(); err != nil {
		log.Fatal(err)
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
	log.Printf("simulator listening on %s (esx=%v)", s.URL.Host, *esx)
	select {}
}
