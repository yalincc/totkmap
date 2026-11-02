package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTargetEndpoints(t *testing.T) {
	// 1. 测试初始 GET /target -> {"ok": false}
	req := httptest.NewRequest(http.MethodGet, "/target", nil)
	w := httptest.NewRecorder()
	handleTargetPC(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var res map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if res["ok"] != false {
		t.Fatalf("expected ok:false, got %v", res)
	}

	// 2. 测试 POST /target 设置目标
	body := map[string]any{
		"name":  "克洛格果实",
		"x":     -1403.0,
		"y":     78.0,
		"type":  "korok",
		"layer": 18,
	}
	buf, _ := json.Marshal(body)
	req = httptest.NewRequest(http.MethodPost, "/target", bytes.NewReader(buf))
	w = httptest.NewRecorder()
	handleTargetPC(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	res = nil
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if res["ok"] != true {
		t.Fatalf("expected ok:true, got %v", res)
	}
	tgt, ok := res["target"].(map[string]any)
	if !ok || tgt["name"] != "克洛格果实" {
		t.Fatalf("unexpected target: %v", res["target"])
	}

	// 3. 测试 handlePosPC 中带有 target
	req = httptest.NewRequest(http.MethodGet, "/pos", nil)
	w = httptest.NewRecorder()
	handlePosPC(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var posRes map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &posRes); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	posTgt, ok := posRes["target"].(map[string]any)
	if !ok || posTgt["name"] != "克洛格果实" {
		t.Fatalf("expected target in pos, got %v", posRes["target"])
	}

	// 4. 测试 POST /target {clear:true}
	clearBuf, _ := json.Marshal(map[string]any{"clear": true})
	req = httptest.NewRequest(http.MethodPost, "/target", bytes.NewReader(clearBuf))
	w = httptest.NewRecorder()
	handleTargetPC(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	// 5. 再次验证 GET /pos 中 target 为 nil
	req = httptest.NewRequest(http.MethodGet, "/pos", nil)
	w = httptest.NewRecorder()
	handlePosPC(w, req)
	posRes = nil
	_ = json.Unmarshal(w.Body.Bytes(), &posRes)
	if posRes["target"] != nil {
		t.Fatalf("expected nil target in pos, got %v", posRes["target"])
	}
}

