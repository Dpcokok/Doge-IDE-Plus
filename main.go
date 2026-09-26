//go:build windows

// Doge IDE desktop shell: embeds the web app, serves it on 127.0.0.1:8787,
// proxies /api/v1/execution/run to the cloud sandbox and shows it in a WebView2 window.
package main

import (
	"bytes"
	"context"
	"embed"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	appName    = "Doge IDE"
	appTitle   = "Doge IDE - 轻量在线编程工具"
	appVersion = "1.0.0"
	listenAddr = "127.0.0.1:8787"
	upstream   = "https://uapis.cn/api/v1/execution/run"
	mutexName  = `Local\DogeIDE_SingleInstance`
)

//go:embed doge-ide.html
var indexHTML []byte

//go:embed all:web
var webFS embed.FS

func main() {
	debug := flag.Bool("debug", false, "enable WebView2 devtools and verbose logs")
	serveOnly := flag.Bool("serve", false, "run the HTTP server only, no window (for testing)")
	flag.Parse()

	// Single instance: focus the existing window (or report) instead of opening a second one.
	if !*serveOnly {
		h, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(mutexName))
		if err == windows.ERROR_ALREADY_EXISTS {
			if !focusExistingWindow() {
				msgBox("Doge IDE 已在运行", "Doge IDE 已在运行，请切换到已打开的窗口。")
			}
			return
		}
		if err != nil && *debug {
			log.Printf("mutex: %v", err)
		}
		if h != 0 {
			defer windows.CloseHandle(h)
		}
		if !webview2RuntimeInstalled() {
			msgBox("缺少 WebView2 运行时",
				"未检测到 Microsoft Edge WebView2 运行时。\n\n请安装后重试：\nhttps://developer.microsoft.com/microsoft-edge/webview2/")
			return
		}
	}

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		if *serveOnly {
			log.Fatalf("listen %s: %v", listenAddr, err)
		}
		msgBox("端口被占用",
			fmt.Sprintf("无法监听 %s：\n%v\n\n请关闭占用该端口的程序后重试。", listenAddr, err))
		return
	}

	srv := &http.Server{Handler: routes()}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("server: %v", err)
		}
	}()
	log.Printf("LISTENING http://%s", listenAddr)

	if *serveOnly {
		waitForInterrupt()
		shutdown(srv)
		return
	}

	dataPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "DogeIDE", "WebView2")
	if err := os.MkdirAll(dataPath, 0o755); err != nil && *debug {
		log.Printf("datapath: %v", err)
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     *debug,
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  appTitle,
			Width:  1500,
			Height: 950,
			IconId: 1,
		},
	})
	if w == nil {
		msgBox("启动失败", "WebView2 窗口创建失败，请确认已安装 Microsoft Edge WebView2 运行时。")
		shutdown(srv)
		return
	}
	defer w.Destroy()
	setMinSize(uintptr(w.Window()), 880, 560)
	fitWindowToWorkArea(uintptr(w.Window()))
	w.Navigate("http://" + listenAddr + "/")
	w.Run()
	shutdown(srv)
}

func routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/execution/run", handleProxy)
	mux.HandleFunc("/", handleStatic)
	return mux
}

func handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean("/" + r.URL.Path)
	if p == "/" || p == "/index.html" || p == "/doge-ide.html" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
		return
	}
	name := strings.TrimPrefix(p, "/")
	if !strings.HasPrefix(name, "web/") {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(webFS, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ct := mime.TypeByExtension(path.Ext(name))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(data)
}

var proxyClient = &http.Client{Timeout: 40 * time.Second}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		proxyError(w, http.StatusBadRequest, "failed to read request body: "+err.Error())
		return
	}
	req, err := http.NewRequest(http.MethodPost, resolveUpstream(r), bytes.NewReader(body))
	if err != nil {
		proxyError(w, http.StatusInternalServerError, err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := proxyClient.Do(req)
	if err != nil {
		proxyError(w, http.StatusBadGateway, "proxy error: "+err.Error())
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func proxyError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":"Proxy error","message":%q}`, msg)
}

// resolveUpstream lets the page pick the target endpoint (same-origin request, so no
// CORS preflight). Anything that is not a plain http(s) URL falls back to the default.
func resolveUpstream(r *http.Request) string {
	v := strings.TrimSpace(r.Header.Get("X-Doge-Upstream"))
	if v == "" || len(v) > 2048 {
		return upstream
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return upstream
	}
	return v
}

func waitForInterrupt() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	<-ch
}

func shutdown(srv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func webview2RuntimeInstalled() bool {
	const guid = `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
	paths := []struct {
		root registry.Key
		key  string
	}{
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\` + guid},
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\EdgeUpdate\Clients\` + guid},
		{registry.CURRENT_USER, `SOFTWARE\Microsoft\EdgeUpdate\Clients\` + guid},
	}
	for _, p := range paths {
		k, err := registry.OpenKey(p.root, p.key, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v, _, err := k.GetStringValue("pv")
		k.Close()
		if err == nil && v != "" && v != "0.0.0.0" {
			return true
		}
	}
	return false
}

func focusExistingWindow() bool {
	user32 := windows.NewLazySystemDLL("user32.dll")
	findWindow := user32.NewProc("FindWindowW")
	showWindow := user32.NewProc("ShowWindowW")
	setForeground := user32.NewProc("SetForegroundWindow")
	title, err := windows.UTF16PtrFromString(appTitle)
	if err != nil {
		return false
	}
	hwnd, _, _ := findWindow.Call(0, uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return false
	}
	const swRestore = 9
	showWindow.Call(hwnd, swRestore)
	setForeground.Call(hwnd)
	return true
}

func msgBox(title, text string) {
	user32 := windows.NewLazySystemDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	const mbOK, mbIconError, mbTopmost = 0x0, 0x10, 0x40000
	textPtr, err1 := windows.UTF16PtrFromString(text)
	titlePtr, err2 := windows.UTF16PtrFromString(title)
	if err1 != nil || err2 != nil {
		return
	}
	messageBox.Call(0,
		uintptr(unsafe.Pointer(textPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		uintptr(mbOK|mbIconError|mbTopmost))
}

// setMinSize enforces a minimum window size via a WM_GETMINMAXINFO subclass.
func setMinSize(hwnd uintptr, minW, minH int32) {
	if hwnd == 0 {
		return
	}
	user32 := windows.NewLazySystemDLL("user32.dll")
	setWindowLongPtr := user32.NewProc("SetWindowLongPtrW")
	callWindowProc := user32.NewProc("CallWindowProcW")

	type point struct{ X, Y int32 }
	type minMaxInfo struct {
		PtReserved     point
		PtMaxSize      point
		PtMaxPosition  point
		PtMinTrackSize point
		PtMaxTrackSize point
	}

	const gwlpWndProc = ^uintptr(3) // -4
	const wmGetMinMaxInfo = 0x0024

	var origProc uintptr
	cb := syscall.NewCallback(func(h, msg, wparam, lparam uintptr) uintptr {
		if msg == wmGetMinMaxInfo {
			mmi := (*minMaxInfo)(unsafe.Pointer(lparam))
			mmi.PtMinTrackSize.X = minW
			mmi.PtMinTrackSize.Y = minH
			return 0
		}
		ret, _, _ := callWindowProc.Call(origProc, h, msg, wparam, lparam)
		return ret
	})
	prev, _, _ := setWindowLongPtr.Call(hwnd, gwlpWndProc, cb)
	origProc = prev
}

// fitWindowToWorkArea sizes the window to ~92% of the desktop work area
// (capped at 1720x1080) and centers it, so the editor content is fully visible.
func fitWindowToWorkArea(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	user32 := windows.NewLazySystemDLL("user32.dll")
	spi := user32.NewProc("SystemParametersInfoW")
	setWindowPos := user32.NewProc("SetWindowPos")

	type rect struct{ Left, Top, Right, Bottom int32 }
	var wa rect
	const spiGetWorkArea = 0x0030
	ret, _, _ := spi.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&wa)), 0)
	if ret == 0 {
		return
	}
	workW := wa.Right - wa.Left
	workH := wa.Bottom - wa.Top

	const minW, minH int32 = 1000, 650
	w := workW * 94 / 100
	h := workH * 94 / 100
	if w > 2200 {
		w = 2200
	}
	if h > 1400 {
		h = 1400
	}
	if w < minW {
		w = workW
	}
	if h < minH {
		h = workH
	}
	x := wa.Left + (workW-w)/2
	y := wa.Top + (workH-h)/2

	const swpNoZOrder, swpNoActivate = 0x0004, 0x0010
	setWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), uintptr(swpNoZOrder|swpNoActivate))
}
