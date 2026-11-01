using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Only a completed Ctrl tap leaves this process. Key names and text are never emitted.
public sealed class CtrlTapDetector {
    readonly HashSet<int> held = new HashSet<int>();
    bool candidate; long began;
    public void Cancel() { candidate = false; }
    public bool Key(int key, bool down, long now, bool injected = false) {
        bool ctrl = key == 162 || key == 163 || key == 17;
        if (down) {
            if (held.Contains(key)) return false;
            if (ctrl) { candidate = held.Count == 0 && !injected; began = now; }
            else candidate = false;
            held.Add(key); return false;
        }
        bool known = held.Remove(key);
        bool tap = ctrl && known && candidate && held.Count == 0 && now - began <= 500 && now >= began;
        if (ctrl) candidate = false;
        return tap;
    }
}
public static class CtrlTapHost {
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; public uint extra; }
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int type, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    static readonly CtrlTapDetector detector = new CtrlTapDetector();
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static Hook keyboard = Keyboard, mouse = Mouse;
    static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
        if (code >= 0) {
            int msg = message.ToInt32();
            if (msg == 0x100 || msg == 0x104 || msg == 0x101 || msg == 0x105) {
                int key = Marshal.ReadInt32(data), flags = Marshal.ReadInt32(data, 8);
                if (detector.Key(key, msg == 0x100 || msg == 0x104, clock.ElapsedMilliseconds, (flags & 16) != 0))
                    ThreadPool.QueueUserWorkItem(_ => { try { Console.WriteLine("tap"); Console.Out.Flush(); } catch {} });
                if ((key == 162 || key == 163 || key == 17) && (msg == 0x100 || msg == 0x104)) {
                    foreach (int button in new int[] { 1, 2, 4, 5, 6 }) if ((GetAsyncKeyState(button) & 0x8000) != 0) detector.Cancel();
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }
    static IntPtr Mouse(int code, IntPtr message, IntPtr data) {
        int msg = message.ToInt32();
        if (code >= 0 && (msg == 0x201 || msg == 0x204 || msg == 0x207 || msg == 0x20b || msg == 0x20a || msg == 0x20e)) detector.Cancel();
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }
    public static void Run() {
        Message msg; PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);
        uint thread = GetCurrentThreadId();
        // Keys already held at startup cannot form a fresh tap.
        for (int key = 8; key < 256; key++) if (key != 16 && key != 17 && key != 18 && (GetAsyncKeyState(key) & 0x8000) != 0) detector.Key(key, true, clock.ElapsedMilliseconds, true);
        detector.Cancel();
        IntPtr keys = SetWindowsHookEx(13, keyboard, GetModuleHandle(null), 0);
        IntPtr clicks = SetWindowsHookEx(14, mouse, GetModuleHandle(null), 0);
        try {
            if (keys == IntPtr.Zero || clicks == IntPtr.Zero) throw new Exception("hook-unavailable");
            var exit = new Thread(() => { try { Console.In.ReadToEnd(); } finally { PostThreadMessage(thread, 0x12, UIntPtr.Zero, IntPtr.Zero); } });
            exit.IsBackground = true; exit.Start(); Console.WriteLine("ready"); Console.Out.Flush();
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {}
        } finally { if (keys != IntPtr.Zero) UnhookWindowsHookEx(keys); if (clicks != IntPtr.Zero) UnhookWindowsHookEx(clicks); }
    }
}
