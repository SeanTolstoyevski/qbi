package logging

import (
	"os"
	"path/filepath"
	"sync"
)

// fileMaxSize caps a single log file; on overflow the current file rolls over
// to <path>.1 (one backup generation) and a fresh file is started. Desktop
// logs are low-volume; this bounds disk usage without a rotation dependency.
const fileMaxSize = 5 << 20 // 5 MB

// fileWriter is an append-only, size-capped log destination. Writes are
// serialized so concurrent handlers cannot interleave lines.
type fileWriter struct {
	mu      sync.Mutex
	path    string
	maxSize int64
	f       *os.File
	size    int64
}

func newFileWriter(path string) (*fileWriter, error) {
	return newFileWriterSize(path, fileMaxSize)
}

func newFileWriterSize(path string, maxSize int64) (*fileWriter, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	fw := &fileWriter{path: path, maxSize: maxSize}
	if err := fw.open(); err != nil {
		return nil, err
	}
	return fw, nil
}

func (w *fileWriter) open() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	w.f, w.size = f, st.Size()
	return nil
}

func (w *fileWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	if w.size+int64(len(p)) > w.maxSize {
		if err := w.rotate(); err != nil {
			if w.f == nil {
				if oerr := w.open(); oerr != nil {
					return 0, oerr
				}
			}
		}
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

// rotate closes the current file and moves it aside, keeping one backup.
func (w *fileWriter) rotate() error {
	f := w.f
	w.f = nil
	if err := f.Close(); err != nil {
		return err
	}
	backup := w.path + ".1"
	_ = os.Remove(backup)
	if err := os.Rename(w.path, backup); err != nil && !os.IsNotExist(err) {
		return err
	}
	return w.open()
}

func (w *fileWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return nil
	}
	err := w.f.Close()
	w.f = nil
	return err
}
