package logging

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestFileWriterAppends(t *testing.T) {
	fw, err := newFileWriterSize(filepath.Join(t.TempDir(), "a.log"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer fw.Close()
	for i := 0; i < 3; i++ {
		if _, err := fw.Write([]byte("line\n")); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(fw.path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "line\nline\nline\n" {
		t.Errorf("content = %q", data)
	}
}

func TestFileWriterSurvivesRotateFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.log")
	if err := os.MkdirAll(filepath.Join(path+".1", "blocker"), 0o755); err != nil {
		t.Fatal(err)
	}
	fw, err := newFileWriterSize(path, 512)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(make([]byte, 400)); err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte("keepme")); err != nil {
		t.Fatalf("write after failed rotation: %v", err)
	}
	fw.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("keepme")) {
		t.Errorf("record lost after failed rotation (file has %d bytes)", len(data))
	}
}

func TestFileWriterRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r.log")
	fw, err := newFileWriterSize(path, 1024)
	if err != nil {
		t.Fatal(err)
	}

	fill := make([]byte, 900)
	if _, err := fw.Write(fill); err != nil {
		t.Fatal(err)
	}
	tail := make([]byte, 300)
	copy(tail, []byte("tail"))
	if _, err := fw.Write(tail); err != nil {
		t.Fatal(err)
	}
	fw.Close()

	cur, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cur) != 300 {
		t.Errorf("current file size = %d, want 300", len(cur))
	}
	backup, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}
	if len(backup) != 900 {
		t.Errorf("backup size = %d, want 900", len(backup))
	}
}
