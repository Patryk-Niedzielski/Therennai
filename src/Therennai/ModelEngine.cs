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

    private const string NotInstalled = "Therennai's brain isn't installed yet. Run install-brain.ps1 to set it up.";

    private readonly HttpClient http = new() { BaseAddress = BaseAddress, Timeout = Timeout.InfiniteTimeSpan };

    // Engine process started by this app, stopped again when the app closes.
    private Process? startedEngine;

    /// <summary>Streams a chat reply, calling <paramref name="onText"/> for each piece of text.</summary>
    public async Task ChatAsync(string model, JsonArray messages, Action<string> onText, CancellationToken ct)
    {
        await EnsureRunningAsync(ct);

        var body = new JsonObject { ["model"] = model, ["messages"] = messages, ["stream"] = true };
        using var request = new HttpRequestMessage(HttpMethod.Post, "api/chat")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);

        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new EngineException("This model isn't installed yet. Run install-brain.ps1 to set it up.");
        if (!response.IsSuccessStatusCode)
            throw new EngineException(ReadError(await response.Content.ReadAsStringAsync(ct))
                ?? $"Therennai's brain returned error {(int)response.StatusCode}.");

        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(ct));
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0) continue;
            JsonNode? chunk = JsonNode.Parse(line);
            if (ReadError(line) is { } error) throw new EngineException(error);

            string? text = chunk?["message"]?["content"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(text)) onText(text);
            if (chunk?["done"]?.GetValue<bool>() == true) break;
        }
    }

    private async Task EnsureRunningAsync(CancellationToken ct)
    {
        if (await IsRunningAsync(ct)) return;
        if (!File.Exists(EnginePath)) throw new EngineException(NotInstalled);

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

    private static string? ReadError(string json)
    {
        try { return JsonNode.Parse(json)?["error"]?.GetValue<string>(); }
        catch { return null; }
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

internal sealed class EngineException(string message) : Exception(message);
