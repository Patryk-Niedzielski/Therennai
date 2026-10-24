using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Therennai;

/// <summary>Main window: hosts the chat interface from the bundled ui folder.</summary>
internal sealed class MainForm : Form
{
    // Virtual host the ui folder is served from, so the page gets a stable origin for saved chats.
    private const string UiHost = "therennai.app";

    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly ModelEngine engine = new();
    private CancellationTokenSource? activeReply;

    public MainForm()
    {
        Text = "Therennai";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(1200, 800);
        MinimumSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = IsDarkMode() ? Color.FromArgb(30, 30, 28) : Color.FromArgb(247, 247, 245);
        Controls.Add(webView);

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
        int dark = IsDarkMode() ? 1 : 0;
        DwmSetWindowAttribute(Handle, DwmUseImmersiveDarkMode, ref dark, sizeof(int));
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

    /// <summary>Handles "chat" and "stop" requests from the interface.</summary>
    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? request = JsonNode.Parse(e.WebMessageAsJson);
        string? type = request?["type"]?.GetValue<string>();

        if (type == "stop")
        {
            activeReply?.Cancel();
            return;
        }
        if (type != "chat" || request is null) return;

        string requestId = request["requestId"]!.GetValue<string>();
        string model = request["model"]!.GetValue<string>();
        string permission = request["permission"]?.GetValue<string>() ?? "chat";

        activeReply?.Cancel();
        using var cts = new CancellationTokenSource();
        activeReply = cts;

        try
        {
            var messages = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = BuildSystemPrompt(model, permission) },
            };
            foreach (JsonNode? message in request["messages"]!.AsArray())
                messages.Add(message!.DeepClone());

            await engine.ChatAsync(model, messages,
                text => Post(new JsonObject { ["type"] = "chunk", ["requestId"] = requestId, ["text"] = text }),
                cts.Token);
            Post(new JsonObject { ["type"] = "done", ["requestId"] = requestId });
        }
        catch (OperationCanceledException)
        {
            Post(new JsonObject { ["type"] = "done", ["requestId"] = requestId });
        }
        catch (Exception ex) when (ex is EngineException or HttpRequestException or IOException)
        {
            string message = ex is EngineException ? ex.Message : "Lost the connection to Therennai's brain.";
            Post(new JsonObject { ["type"] = "error", ["requestId"] = requestId, ["message"] = message });
        }
        finally
        {
            if (activeReply == cts) activeReply = null;
        }
    }

    private void Post(JsonObject message)
    {
        if (!IsDisposed && webView.CoreWebView2 is not null)
            webView.CoreWebView2.PostWebMessageAsJson(message.ToJsonString());
    }

    /// <summary>The model's system prompt from models/&lt;model&gt;/system.txt plus the current permission mode.</summary>
    private static string BuildSystemPrompt(string model, string permission)
    {
        string folder = Regex.Replace(model, "[^a-z0-9.]", "-");
        string path = Path.Combine(AppContext.BaseDirectory, "models", folder, "system.txt");
        string prompt = File.Exists(path) ? File.ReadAllText(path) : "You are Therennai, a helpful AI agent.";

        string access = permission == "chat"
            ? "Permission mode: Chat only. You have no access to the user's files, apps or commands."
            : "Tools for acting on the PC aren't connected in this version, so you can't read files or run commands yet. " +
              "When a task needs that, give the user the exact steps instead.";
        return prompt.TrimEnd() + "\n\n" + access;
    }

    private static bool IsDarkMode()
    {
        object? value = Registry.GetValue(
            @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
        return value is int light && light == 0;
    }

    private const int DwmUseImmersiveDarkMode = 20;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
