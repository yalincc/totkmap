package main

import (
	"testing"
)

func TestLiveStaticChain(t *testing.T) {
	p := probePlatform()
	if p == nil {
		t.Skip("no platform found")
	}
	plat, ok := p.(*totkpcPlatform)
	if !ok {
		t.Skip("not totkpc platform")
	}
	if !p.Attach() {
		t.Skip("totk.exe not running")
	}

	mainBase := plat.MainBase()
	if mainBase == 0 {
		t.Fatalf("mainBase is 0")
	}
	t.Logf("Attached to PID %d, mainBase: 0x%X", p.PID(), mainBase)

	pos, addr, ok := ptkReadStaticChain(p.Handle(), mainBase)
	if !ok {
		t.Fatalf("ptkReadStaticChain failed to read live position")
	}
	t.Logf("SUCCESS! Read Link coords: (%.2f, %.2f, %.2f) at heap addr 0x%X", pos[0], pos[1], pos[2], addr)

	if pos[0] == 0 && pos[1] == 0 {
		t.Fatalf("invalid (0,0) coords")
	}
}
