using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Therennai;

/// <summary>Main window: hosts the chat interface from the bundled ui folder.</summary>
internal sealed class MainForm : Form
{
    // Virtual host the ui folder is served from, so the page gets a stable origin for saved chats.
    private const string UiHost = "therennai.app";

    // Therennai's GitHub repository: /bug opens a new issue there, and update checks read its latest release.
    private const string RepoUrl = "https://github.com/Patryk-Niedzielski/Therennai";
    private const string IssuesUrl = RepoUrl + "/issues/new";
    private const string LatestReleaseApi = "https://api.github.com/repos/Patryk-Niedzielski/Therennai/releases/latest";

    private static readonly HttpClient Web = CreateWebClient();

    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly ModelEngine engine = new();
    private CancellationTokenSource? activeReply;
    private string themeMode = "system";

    public MainForm()
    {
        Text = "Therennai";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(1200, 800);
        MinimumSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(webView);
        ApplyTheme(themeMode);

        Load += async (_, _) => await InitializeWebViewAsync();
        FormClosed += (_, _) =>
        {
            activeReply?.Cancel();
            engine.Dispose();
        };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyTheme(themeMode);
        // Recalculate the frame so the custom title bar (WM_NCCALCSIZE below) takes effect right away.
        SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoZOrder | SwpFrameChanged);
        UpdateCorners();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (!IsHandleCreated) return;
        UpdateCorners();
        Post(new JsonObject { ["type"] = "window-state", ["maximized"] = WindowState == FormWindowState.Maximized });
    }

    /// <summary>
    /// Removes the standard Windows title bar: the interface draws its own (ui/index.html), like other chat apps.
    /// The window keeps its resizable frame style, so snapping, maximizing and the taskbar behave normally.
    /// </summary>
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmNcCalcSize && m.WParam != IntPtr.Zero)
        {
            // A maximized window hangs over the screen edges by the frame size; pull the client area back in.
            if (IsZoomed(Handle))
            {
                int dpi = (int)GetDpiForWindow(Handle);
                int padding = GetSystemMetricsForDpi(SmCxPaddedBorder, dpi);
                int frameX = GetSystemMetricsForDpi(SmCxFrame, dpi) + padding;
                int frameY = GetSystemMetricsForDpi(SmCyFrame, dpi) + padding;
                var rect = Marshal.PtrToStructure<Rect>(m.LParam);
                rect.Left += frameX;
                rect.Top += frameY;
                rect.Right -= frameX;
                rect.Bottom -= frameY;
                Marshal.StructureToPtr(rect, m.LParam, false);
            }
            m.Result = IntPtr.Zero;
            return;
        }
        if (m.Msg == WmNcActivate)
        {
            // Stop Windows from repainting the (hidden) title bar when the window gains or loses focus.
            m.Result = DefWindowProc(m.HWnd, m.Msg, m.WParam, new IntPtr(-1));
            return;
        }
        base.WndProc(ref m);
    }

    /// <summary>Rounds the window corners: the system's smooth rounding on Windows 11, a window region on Windows 10.</summary>
    private void UpdateCorners()
    {
        if (Environment.OSVersion.Version.Build >= 22000)
        {
            int round = DwmcpRound;
            DwmSetWindowAttribute(Handle, DwmWindowCornerPreference, ref round, sizeof(int));
            return;
        }
        if (WindowState == FormWindowState.Maximized)
        {
            SetWindowRgn(Handle, IntPtr.Zero, true);
            return;
        }
        int diameter = (int)Math.Round(CornerRadius * 2 * DeviceDpi / 96.0);
        // The window owns the region after SetWindowRgn, so it isn't deleted here.
        SetWindowRgn(Handle, CreateRoundRectRgn(0, 0, Width + 1, Height + 1, diameter, diameter), true);
    }

    /// <summary>Title bar actions from the interface: moving, resizing, minimizing, maximizing and closing.</summary>
    private void HandleWindowAction(string? action, string? edge)
    {
        switch (action)
        {
            case "drag":
                ReleaseCapture();
                SendMessage(Handle, WmNcLButtonDown, HtCaption, IntPtr.Zero);
                break;
            case "resize" when WindowState == FormWindowState.Normal && edge is not null && ResizeEdges.TryGetValue(edge, out int hit):
                ReleaseCapture();
                SendMessage(Handle, WmNcLButtonDown, hit, IntPtr.Zero);
                break;
            case "minimize":
                WindowState = FormWindowState.Minimized;
                break;
            case "toggle-maximize":
                WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                break;
            case "close":
                Close();
                break;
        }
    }

    private static readonly Dictionary<string, int> ResizeEdges = new()
    {
        ["left"] = 10, ["right"] = 11, ["top"] = 12, ["top-left"] = 13,
        ["top-right"] = 14, ["bottom"] = 15, ["bottom-left"] = 16, ["bottom-right"] = 17,
    };

    private async Task InitializeWebViewAsync()
    {
        try
        {
            string dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Therennai", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await webView.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                "Therennai needs the Microsoft Edge WebView2 Runtime.\n\n" + ex.Message,
                "Therennai", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        CoreWebView2 core = webView.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
#if !DEBUG
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.NewWindowRequested += (_, args) => args.Handled = true;
        core.WebMessageReceived += OnWebMessageReceived;
        core.NavigationCompleted += (_, _) => Post(new JsonObject { ["type"] = "app-info", ["version"] = AppVersion });

        core.SetVirtualHostNameToFolderMapping(
            UiHost, Path.Combine(AppContext.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.Deny);
        webView.Source = new Uri($"https://{UiHost}/index.html");
    }

    /// <summary>Handles requests from the interface (chat replies, model installs and slash commands).</summary>
    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? request = JsonNode.Parse(e.WebMessageAsJson);
        if (request?["type"]?.GetValue<string>() is not { } type) return;
        string? requestId = request["requestId"]?.GetValue<string>();

        switch (type)
        {
            case "stop":
                activeReply?.Cancel();
                break;
            case "preload":
                string preloadModel = request["model"]!.GetValue<string>();
                await engine.PreloadAsync(preloadModel, ContextTokens(preloadModel));
                break;
            case "theme":
                ApplyTheme(request["value"]?.GetValue<string>() ?? "system");
                break;
            case "exit":
                Close();
                break;
            case "window":
                HandleWindowAction(request["action"]?.GetValue<string>(), request["edge"]?.GetValue<string>());
                break;
            case "report-bug":
                OpenInBrowser(IssuesUrl);
                break;
            case "open-link" when request["url"]?.GetValue<string>() is { } url && url.StartsWith(RepoUrl + "/"):
                // Only links into Therennai's own repository (release pages from the update check).
                OpenInBrowser(url);
                break;
            case "check-update":
                PostResult(requestId!, await CheckForUpdatesAsync());
                break;
            case "status":
                PostResult(requestId!, await GetStatusAsync());
                break;
            case "doctor":
                PostResult(requestId!, new JsonObject { ["checks"] = await RunDoctorAsync() });
                break;
            case "export":
                PostResult(requestId!, Export(request["title"]!.GetValue<string>(), request["markdown"]!.GetValue<string>()));
                break;
            case "chat" or "install" or "uninstall":
                await RunReplyAsync(type, requestId!, request);
                break;
        }
    }

    /// <summary>Streams a chat reply or install progress into the chat.</summary>
    private async Task RunReplyAsync(string type, string requestId, JsonNode request)
    {
        string model = request["model"]!.GetValue<string>();

        activeReply?.Cancel();
        using var cts = new CancellationTokenSource();
        activeReply = cts;

        try
        {
            JsonObject? usage = null;
            if (type is "install" or "uninstall")
            {
                await new ModelInstaller(engine).RunAsync(type, model,
                    text => Post(new JsonObject { ["type"] = "status", ["requestId"] = requestId, ["text"] = text }),
                    cts.Token);
            }
            else
            {
                string permission = request["permission"]?.GetValue<string>() ?? "chat";
                List<string> memory = request["memory"]?.AsArray().Select(m => m!.GetValue<string>()).ToList() ?? [];
                var messages = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildSystemPrompt(model, permission, memory) },
                };
                foreach (JsonNode? message in request["messages"]!.AsArray())
                    messages.Add(message!.DeepClone());

                usage = await engine.ChatAsync(model, ContextTokens(model), messages,
                    text => Post(new JsonObject { ["type"] = "chunk", ["requestId"] = requestId, ["text"] = text }),
                    cts.Token);
            }
            Post(new JsonObject { ["type"] = "done", ["requestId"] = requestId, ["usage"] = usage });
        }
        catch (OperationCanceledException)
        {
            Post(new JsonObject { ["type"] = "done", ["requestId"] = requestId, ["stopped"] = true });
        }
        catch (Exception ex) when (ex is EngineException or HttpRequestException or IOException
                                       or System.ComponentModel.Win32Exception)
        {
            string message = ex switch
            {
                EngineException => ex.Message,
                System.ComponentModel.Win32Exception => "Couldn't start the installer.",
                _ => "Lost the connection to Therennai's brain.",
            };
            Post(new JsonObject
            {
                ["type"] = "error",
                ["requestId"] = requestId,
                ["message"] = message,
                ["code"] = (ex as EngineException)?.Code,
            });
        }
        finally
        {
            if (activeReply == cts) activeReply = null;
        }
    }

    private async Task<JsonObject> GetStatusAsync()
    {
        JsonObject status = await engine.GetStatusAsync(CancellationToken.None);
        status["appVersion"] = typeof(MainForm).Assembly.GetName().Version?.ToString(3);
        status["diskFreeGB"] = Math.Round(FreeDiskGB(), 1);
        return status;
    }

    /// <summary>Health checks for /doctor.</summary>
    private async Task<JsonArray> RunDoctorAsync()
    {
        var checks = new JsonArray();
        void Add(string name, bool ok, string detail) =>
            checks.Add(new JsonObject { ["name"] = name, ["ok"] = ok, ["detail"] = detail });

        Add("Therennai app", true, "version " + typeof(MainForm).Assembly.GetName().Version?.ToString(3));
        try { Add("WebView2 runtime", true, "version " + CoreWebView2Environment.GetAvailableBrowserVersionString()); }
        catch (WebView2RuntimeNotFoundException) { Add("WebView2 runtime", false, "not found"); }

        double freeGB = FreeDiskGB();
        Add("Disk space", freeGB >= 5, $"{freeGB:0.0} GB free" + (freeGB >= 5 ? "" : ", free up some space"));

        if (!ModelEngine.IsInstalled)
        {
            Add("Therennai engine", false, "not installed, type /install model 1.0");
            return checks;
        }

        HashSet<string> installed;
        try
        {
            installed = await engine.GetInstalledModelsAsync(CancellationToken.None);
            Add("Therennai engine", true, "installed and responding");
        }
        catch (Exception ex) when (ex is EngineException or HttpRequestException)
        {
            Add("Therennai engine", false, ex is EngineException ? ex.Message : "not responding");
            return checks;
        }

        var models = ModelInstaller.AvailableModels();
        foreach (var model in models)
        {
            bool ok = installed.Contains(model.Id);
            Add(model.Name, ok, ok ? "installed" : $"not installed, type /install model {model.Version}");
        }

        JsonObject status = await engine.GetStatusAsync(CancellationToken.None);
        foreach (JsonNode? loaded in status["loaded"]?.AsArray() ?? [])
        {
            string id = loaded!["name"]!.GetValue<string>();
            string name = models.FirstOrDefault(m => m.Id == id)?.Name ?? id;
            double size = loaded["sizeGB"]!.GetValue<double>();
            double gpu = loaded["gpuGB"]!.GetValue<double>();
            Add($"GPU ({name})", gpu >= size * 0.99,
                gpu >= size * 0.99 ? "fully on the GPU" : $"{gpu:0.0} of {size:0.0} GB on the GPU, the rest runs slower on the CPU");
        }
        return checks;
    }

    /// <summary>Saves a chat for /export, letting the user pick where.</summary>
    private JsonObject Export(string title, string markdown)
    {
        string fileName = string.Concat(title.Split(Path.GetInvalidFileNameChars())).Trim();
        using var dialog = new SaveFileDialog
        {
            Title = "Export chat",
            Filter = "Markdown (*.md)|*.md|Text (*.txt)|*.txt",
            FileName = (fileName.Length > 0 ? fileName : "Therennai chat") + ".md",
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return new JsonObject { ["cancelled"] = true };

        File.WriteAllText(dialog.FileName, markdown);
        return new JsonObject { ["path"] = dialog.FileName };
    }

    /// <summary>Compares this version with the latest release published on GitHub.</summary>
    private static async Task<JsonObject> CheckForUpdatesAsync()
    {
        string current = AppVersion;
        try
        {
            using var response = await Web.GetAsync(LatestReleaseApi);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                return new JsonObject { ["current"] = current, ["upToDate"] = true };
            response.EnsureSuccessStatusCode();

            JsonNode release = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
            string latest = release["tag_name"]!.GetValue<string>().TrimStart('v', 'V');
            bool newer = Version.TryParse(latest, out Version? latestVersion)
                && Version.TryParse(current, out Version? currentVersion)
                && latestVersion > currentVersion;
            string notes = release["body"]?.GetValue<string>() ?? "";
            return new JsonObject
            {
                ["current"] = current,
                ["latest"] = latest,
                ["upToDate"] = !newer,
                ["url"] = release["html_url"]?.GetValue<string>(),
                ["notes"] = notes.Length > 800 ? notes[..800] + "…" : notes,
            };
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            return new JsonObject { ["current"] = current, ["error"] = "Couldn't reach GitHub. Check your internet connection and try again." };
        }
    }

    private static string AppVersion => typeof(MainForm).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    private static HttpClient CreateWebClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Therennai/" + AppVersion);
        return client;
    }

    private static void OpenInBrowser(string url) =>
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();

    private void PostResult(string requestId, JsonObject data) =>
        Post(new JsonObject { ["type"] = "result", ["requestId"] = requestId, ["data"] = data });

    private void Post(JsonObject message)
    {
        if (!IsDisposed && webView.CoreWebView2 is not null)
            webView.CoreWebView2.PostWebMessageAsJson(message.ToJsonString());
    }

    /// <summary>
    /// The model's system prompt from models/&lt;model&gt;/system.txt, plus the permission mode
    /// and anything the user saved with /memory.
    /// </summary>
    private static string BuildSystemPrompt(string model, string permission, List<string> memory)
    {
        string path = Path.Combine(ModelInstaller.ModelFolder(model), "system.txt");
        string prompt = File.Exists(path) ? File.ReadAllText(path) : "You are Therennai, a helpful AI agent.";

        string access = permission == "chat"
            ? "Permission mode: Chat only. You have no access to the user's files, apps or commands."
            : "Tools for acting on the PC aren't connected in this version, so you can't read files or run commands yet. " +
              "When a task needs that, give the user the exact steps instead.";
        prompt = prompt.TrimEnd() + "\n\n" + access;

        if (memory.Count > 0)
            prompt += "\n\nThings the user asked you to remember:\n" + string.Join("\n", memory.Select(m => "- " + m));
        return prompt;
    }

    private static int ContextTokens(string model) => ModelInstaller.FindModel(model)?.ContextTokens ?? 8192;

    private static double FreeDiskGB()
    {
        string root = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData))!;
        return new DriveInfo(root).AvailableFreeSpace / 1e9;
    }

    /// <summary>Applies "light", "dark" or "system" to the window background (shown while the interface loads).</summary>
    private void ApplyTheme(string mode)
    {
        themeMode = mode;
        bool dark = mode == "dark" || (mode != "light" && IsWindowsDarkMode());
        BackColor = dark ? Color.FromArgb(30, 30, 28) : Color.FromArgb(247, 247, 245);
        if (!IsHandleCreated) return;

        // Also used by Windows for the window's system menu and snap previews.
        int value = dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, DwmUseImmersiveDarkMode, ref value, sizeof(int));
    }

    private static bool IsWindowsDarkMode()
    {
        object? value = Registry.GetValue(
            @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
        return value is int light && light == 0;
    }

    private const int CornerRadius = 10;

    private const int DwmUseImmersiveDarkMode = 20;
    private const int DwmWindowCornerPreference = 33;
    private const int DwmcpRound = 2;
    private const int WmNcCalcSize = 0x0083;
    private const int WmNcActivate = 0x0086;
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtCaption = 2;
    private const int SmCxFrame = 32;
    private const int SmCyFrame = 33;
    private const int SmCxPaddedBorder = 92;
    private const uint SwpNoSize = 0x0001, SwpNoMove = 0x0002, SwpNoZOrder = 0x0004, SwpFrameChanged = 0x0020;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, int dpi);

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, int wParam, IntPtr lParam);
}
