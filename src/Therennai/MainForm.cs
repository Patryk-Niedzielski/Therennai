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

    // Where /bug and /feedback send the user.
    private const string IssuesUrl = "https://github.com/Patryk-Niedzielski/Therennai/issues/new";

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
    }

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
                await engine.PreloadAsync(request["model"]!.GetValue<string>());
                break;
            case "theme":
                ApplyTheme(request["value"]?.GetValue<string>() ?? "system");
                break;
            case "exit":
                Close();
                break;
            case "report-bug":
                Process.Start(new ProcessStartInfo(IssuesUrl) { UseShellExecute = true })?.Dispose();
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

                usage = await engine.ChatAsync(model, messages,
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

    private static double FreeDiskGB()
    {
        string root = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData))!;
        return new DriveInfo(root).AvailableFreeSpace / 1e9;
    }

    /// <summary>Applies "light", "dark" or "system" to the window background and title bar.</summary>
    private void ApplyTheme(string mode)
    {
        themeMode = mode;
        bool dark = mode == "dark" || (mode != "light" && IsWindowsDarkMode());
        BackColor = dark ? Color.FromArgb(30, 30, 28) : Color.FromArgb(247, 247, 245);
        if (!IsHandleCreated) return;

        int value = dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, DwmUseImmersiveDarkMode, ref value, sizeof(int));
        // Nudge Windows to redraw the title bar with the new colors.
        if (WindowState == FormWindowState.Normal)
        {
            Width += 1;
            Width -= 1;
        }
    }

    private static bool IsWindowsDarkMode()
    {
        object? value = Registry.GetValue(
            @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
        return value is int light && light == 0;
    }

    private const int DwmUseImmersiveDarkMode = 20;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
