using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Therennai;

/// <summary>Talks to the local model engine that runs Therennai's models on this PC.</summary>
internal sealed class ModelEngine : IDisposable
{
    private static readonly Uri BaseAddress = new("http://127.0.0.1:11434/");

    private static readonly string EnginePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ollama", "ollama.exe");

    // How long the model stays loaded after the last message (the engine's default is 5 minutes).
    private const string KeepAlive = "30m";

    private readonly HttpClient http = new() { BaseAddress = BaseAddress, Timeout = Timeout.InfiniteTimeSpan };

    // Engine process started by this app, stopped again when the app closes.
    private Process? startedEngine;

    public static bool IsInstalled => File.Exists(EnginePath);

    /// <summary>Streams a chat reply, calling <paramref name="onText"/> for each piece of text.</summary>
    public async Task ChatAsync(string model, JsonArray messages, Action<string> onText, CancellationToken ct)
    {
        if (!IsInstalled) throw EngineException.NotInstalled();
        await EnsureRunningAsync(ct);

        var body = new JsonObject
        {
            ["model"] = model, ["messages"] = messages, ["stream"] = true, ["keep_alive"] = KeepAlive,
        };
        await StreamAsync("api/chat", body, chunk =>
        {
            string? text = chunk["message"]?["content"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(text)) onText(text);
        }, ct);
    }

    /// <summary>
    /// Loads the model into memory ahead of the first message, so the first reply doesn't wait for it.
    /// Does nothing if the engine or model isn't installed.
    /// </summary>
    public async Task PreloadAsync(string model)
    {
        if (!IsInstalled) return;
        try
        {
            await EnsureRunningAsync(CancellationToken.None);
            var body = new JsonObject { ["model"] = model, ["messages"] = new JsonArray(), ["keep_alive"] = KeepAlive };
            using var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await http.PostAsync("api/chat", content);
        }
        catch (Exception ex) when (ex is EngineException or HttpRequestException) { }
    }

    public async Task<HashSet<string>> GetInstalledModelsAsync(CancellationToken ct)
    {
        await EnsureRunningAsync(ct);
        return await GetModelNamesAsync("api/tags", ct);
    }

    /// <summary>Unloads a model from memory (if loaded) and deletes it.</summary>
    public async Task DeleteAsync(string model, CancellationToken ct)
    {
        await EnsureRunningAsync(ct);

        // A loaded model keeps its files open, which blocks deleting them on Windows,
        // so unload everything and wait until the engine has let go of the files.
        foreach (string loaded in await GetModelNamesAsync("api/ps", ct))
        {
            var unload = new JsonObject { ["model"] = loaded, ["keep_alive"] = 0 };
            using var unloadContent = new StringContent(unload.ToJsonString(), Encoding.UTF8, "application/json");
            using var _ = await http.PostAsync("api/generate", unloadContent, ct);
        }
        for (int attempt = 0; attempt < 40 && (await GetModelNamesAsync("api/ps", ct)).Count > 0; attempt++)
            await Task.Delay(250, ct);
        await Task.Delay(500, ct);

        var body = new JsonObject { ["model"] = model };
        using var request = new HttpRequestMessage(HttpMethod.Delete, "api/delete")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        using var response = await http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.NotFound)
            throw new EngineException(ReadError(await response.Content.ReadAsStringAsync(ct))
                ?? $"Removing {model} failed.");
    }

    private async Task<HashSet<string>> GetModelNamesAsync(string path, CancellationToken ct)
    {
        string json = await http.GetStringAsync(path, ct);
        return (JsonNode.Parse(json)?["models"]?.AsArray() ?? [])
            .Select(m => m?["name"]?.GetValue<string>())
            .OfType<string>()
            .ToHashSet();
    }

    /// <summary>Installs the engine itself (per user, no admin rights needed).</summary>
    public static async Task InstallEngineAsync(CancellationToken ct)
    {
        // The engine's installer launches its own tray app and window; keep closing it while installing,
        // since Therennai runs the engine in the background itself.
        using var suppress = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task watcher = SuppressEngineAppAsync(suppress.Token);
        try
        {
            await RunHiddenAsync("winget",
                "install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements", ct);
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
        finally
        {
            suppress.Cancel();
            await watcher;
        }
        if (!IsInstalled) throw new EngineException("Therennai's engine couldn't be installed.");

        // Don't start the tray app at sign-in either.
        File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Ollama.lnk"));
        CloseEngineApp();
    }

    private static async Task SuppressEngineAppAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            CloseEngineApp();
            try { await Task.Delay(300, ct); } catch (OperationCanceledException) { }
        }
    }

    private static void CloseEngineApp()
    {
        foreach (Process app in Process.GetProcessesByName("ollama app"))
        {
            try { app.Kill(entireProcessTree: true); } catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            app.Dispose();
        }
    }

    /// <summary>Downloads a base model, reporting (completed, total) bytes of the current download.</summary>
    public async Task PullAsync(string model, Action<long, long> onProgress, CancellationToken ct)
    {
        await EnsureRunningAsync(ct);
        var body = new JsonObject { ["model"] = model, ["stream"] = true };
        await StreamAsync("api/pull", body, chunk =>
        {
            long total = chunk["total"]?.GetValue<long>() ?? 0;
            long completed = chunk["completed"]?.GetValue<long>() ?? 0;
            if (total > 0) onProgress(completed, total);
        }, ct);
    }

    /// <summary>Creates a named model from its Modelfile.</summary>
    public async Task CreateAsync(string model, string modelfilePath, CancellationToken ct)
    {
        await EnsureRunningAsync(ct);
        int exitCode = await RunHiddenAsync(EnginePath, $"create {model} -f \"{modelfilePath}\"", ct);
        if (exitCode != 0) throw new EngineException("Setting up the model failed. Try the install again.");
    }

    private async Task StreamAsync(string path, JsonObject body, Action<JsonNode> onChunk, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);

        if (response.StatusCode == HttpStatusCode.NotFound) throw EngineException.NotInstalled();
        if (!response.IsSuccessStatusCode)
            throw new EngineException(ReadError(await response.Content.ReadAsStringAsync(ct))
                ?? $"Therennai's brain returned error {(int)response.StatusCode}.");

        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(ct));
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0) continue;
            if (ReadError(line) is { } error) throw new EngineException(error);
            JsonNode? chunk = JsonNode.Parse(line);
            if (chunk is null) continue;
            onChunk(chunk);
            if (chunk["done"]?.GetValue<bool>() == true) break;
        }
    }

    private async Task EnsureRunningAsync(CancellationToken ct)
    {
        if (await IsRunningAsync(ct)) return;
        if (!IsInstalled) throw EngineException.NotInstalled();

        startedEngine = Process.Start(new ProcessStartInfo(EnginePath, "serve")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        });

        for (int attempt = 0; attempt < 60; attempt++)
        {
            await Task.Delay(250, ct);
            if (await IsRunningAsync(ct)) return;
        }
        throw new EngineException("Therennai's brain didn't start. Try again in a moment.");
    }

    private async Task<bool> IsRunningAsync(CancellationToken ct)
    {
        try
        {
            using var response = await http.GetAsync("api/version", ct);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
    }

    private static async Task<int> RunHiddenAsync(string fileName, string arguments, CancellationToken ct)
    {
        using var process = Process.Start(new ProcessStartInfo(fileName, arguments)
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        }) ?? throw new EngineException("Couldn't start the installer.");

        try
        {
            await process.WaitForExitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            throw;
        }
        return process.ExitCode;
    }

    /// <summary>The engine's error text, without file paths or the engine's own name.</summary>
    private static string? ReadError(string json)
    {
        string? error;
        try { error = JsonNode.Parse(json)?["error"]?.GetValue<string>(); }
        catch { return null; }
        if (error is null) return null;

        if (error.Contains("being used by another process", StringComparison.OrdinalIgnoreCase))
            return "Some of the model's files are still in use. Close other programs using it and try again.";
        error = System.Text.RegularExpressions.Regex.Replace(error, @"[A-Za-z]:\\\S+", "(file)");
        return System.Text.RegularExpressions.Regex.Replace(error, "ollama", "therennai-engine",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    public void Dispose()
    {
        http.Dispose();
        try
        {
            if (startedEngine is { HasExited: false }) startedEngine.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        startedEngine?.Dispose();
    }
}

internal sealed class EngineException(string message, string? code = null) : Exception(message)
{
    /// <summary>"not-installed" when the engine or the requested model still has to be installed.</summary>
    public string? Code { get; } = code;

    public static EngineException NotInstalled() => new("This model isn't installed yet.", "not-installed");
}
