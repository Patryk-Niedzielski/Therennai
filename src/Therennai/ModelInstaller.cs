using System.Text;
using System.Text.Json.Nodes;

namespace Therennai;

/// <summary>
/// Installs and uninstalls Therennai's models (the /install and /uninstall commands).
/// Each model ships in models/&lt;name&gt;-&lt;version&gt; with a model.json and a Modelfile.
/// </summary>
internal sealed class ModelInstaller(ModelEngine engine)
{
    // Disk space the engine itself needs on first install, plus a safety margin.
    private const double EngineDiskGB = 3;
    private const double MarginGB = 1;

    private sealed record ModelInfo(string Id, string Name, string Version, double DiskGB, string BaseModel, string Folder)
    {
        public string Modelfile => Path.Combine(Folder, "Modelfile");
    }

    private static string ModelsRoot => Path.Combine(AppContext.BaseDirectory, "models");

    /// <summary>Folder holding a model's files, e.g. "therennai:1.0" -> models/therennai-1.0.</summary>
    public static string ModelFolder(string modelId) =>
        Path.Combine(ModelsRoot, System.Text.RegularExpressions.Regex.Replace(modelId, "[^a-z0-9.]", "-"));

    private static ModelInfo LoadModel(string modelId)
    {
        string folder = ModelFolder(modelId);
        string manifest = Path.Combine(folder, "model.json");
        string modelfile = Path.Combine(folder, "Modelfile");
        if (!File.Exists(modelfile) || !File.Exists(manifest))
            throw new EngineException("That model isn't available in this version of Therennai.");

        JsonNode info = JsonNode.Parse(File.ReadAllText(manifest))!;
        string baseModel = File.ReadLines(modelfile)
            .Select(line => line.Trim())
            .FirstOrDefault(line => line.StartsWith("FROM ", StringComparison.OrdinalIgnoreCase))?[5..].Trim()
            ?? throw new EngineException("The model's files are incomplete.");

        return new ModelInfo(modelId, info["name"]!.GetValue<string>(), info["version"]!.GetValue<string>(),
            info["diskGB"]!.GetValue<double>(), baseModel, folder);
    }

    private static List<ModelInfo> AvailableModels() =>
        Directory.Exists(ModelsRoot)
            ? Directory.EnumerateFiles(ModelsRoot, "model.json", SearchOption.AllDirectories)
                .Select(path => JsonNode.Parse(File.ReadAllText(path))!["id"]!.GetValue<string>())
                .Select(LoadModel)
                .OrderBy(m => m.Version)
                .ToList()
            : [];

    /// <summary>Runs /install or /uninstall for one model id, or for every model when it is "all".</summary>
    public Task RunAsync(string command, string modelId, Action<string> report, CancellationToken ct)
    {
        Func<ModelInfo, Action<string>, CancellationToken, Task> action =
            command == "uninstall" ? UninstallAsync : InstallAsync;
        if (modelId != "all") return action(LoadModel(modelId), report, ct);

        string done = command == "uninstall" ? "**All models are uninstalled.**" : "**All models are installed.** Ask me anything.";
        return RunForAllAsync(action, done, report, ct);
    }

    private static async Task RunForAllAsync(
        Func<ModelInfo, Action<string>, CancellationToken, Task> action, string done, Action<string> report, CancellationToken ct)
    {
        // Show each finished model's result above the one in progress.
        var finished = new List<string>();
        foreach (ModelInfo model in AvailableModels())
        {
            string last = "";
            await action(model, text => report(string.Join("\n\n", finished.Append(last = text))), ct);
            finished.Add(last);
        }
        report(string.Join("\n\n", finished.Append(done)));
    }

    private async Task InstallAsync(ModelInfo model, Action<string> report, CancellationToken ct)
    {
        var progress = new StepProgress($"Installing **{model.Name}**", report,
            "Check disk space", "Install Therennai engine", "Download base model", $"Set up {model.Name}");
        try
        {
            // 1. Disk space (and whether it's already installed)
            progress.Start(0);
            bool engineInstalled = ModelEngine.IsInstalled;
            if (engineInstalled)
            {
                progress.Log("therennai-engine list");
                if ((await engine.GetInstalledModelsAsync(ct)).Contains(model.Id))
                {
                    report($"**{model.Name}** is already installed.");
                    return;
                }
            }

            double neededGB = model.DiskGB + MarginGB + (engineInstalled ? 0 : EngineDiskGB);
            string root = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData))!;
            double freeGB = new DriveInfo(root).AvailableFreeSpace / 1e9;
            progress.Log($"check-disk {root.TrimEnd('\\')}  ->  {freeGB:0.0} GB free, {neededGB:0} GB needed");
            if (freeGB < neededGB)
                throw new EngineException(
                    $"Installing {model.Name} needs about {neededGB:0} GB of free space, but only {freeGB:0.0} GB is free. " +
                    "Free up some space and try again.");
            progress.Complete(0);

            // 2. Engine
            if (engineInstalled)
            {
                progress.Complete(1, "already installed");
            }
            else
            {
                progress.Start(1, "this can take a few minutes");
                progress.Log("winget install therennai-engine --silent");
                await ModelEngine.InstallEngineAsync(ct);
                progress.Complete(1);
            }

            // 3. Base model
            progress.Start(2, "starting");
            progress.Log("therennai-engine serve");
            progress.Log($"therennai-engine pull {model.BaseModel}");
            int lastPercent = -1;
            await engine.PullAsync(model.BaseModel, (completed, total) =>
            {
                int percent = (int)(completed * 100 / total);
                if (percent == lastPercent) return;
                lastPercent = percent;
                progress.Detail(2, $"{percent}% ({completed / 1e9:0.0} of {total / 1e9:0.0} GB)");
            }, ct);
            progress.Complete(2);

            // 4. Named model from the Modelfile
            progress.Start(3);
            progress.Log($"therennai-engine create {model.Id} -f models/{Path.GetFileName(model.Folder)}/Modelfile");
            await engine.CreateAsync(model.Id, model.Modelfile, ct);
            progress.Complete(3);

            progress.Finish($"**{model.Name}** is installed.");
        }
        catch (EngineException ex) when (ex.Code is null)
        {
            // Keep the checklist visible, with the failed step marked.
            throw new EngineException(progress.Fail(ex.Message));
        }
    }

    private async Task UninstallAsync(ModelInfo model, Action<string> report, CancellationToken ct)
    {
        HashSet<string> installed = ModelEngine.IsInstalled ? await engine.GetInstalledModelsAsync(ct) : [];
        if (!installed.Contains(model.Id))
        {
            report($"**{model.Name}** isn't installed.");
            return;
        }

        var progress = new StepProgress($"Uninstalling **{model.Name}**", report,
            $"Remove {model.Name}", "Free up disk space");
        try
        {
            progress.Start(0);
            progress.Log($"therennai-engine rm {model.Id}");
            await engine.DeleteAsync(model.Id, ct);
            progress.Complete(0);

            // The base model's download is shared, so only remove it when no other installed model uses it.
            progress.Start(1);
            bool baseStillUsed = AvailableModels()
                .Any(other => other.Id != model.Id && installed.Contains(other.Id) && other.BaseModel == model.BaseModel);
            if (baseStillUsed)
            {
                progress.Complete(1, "base model is still used by another model");
            }
            else
            {
                if (installed.Contains(model.BaseModel))
                {
                    progress.Log($"therennai-engine rm {model.BaseModel}");
                    await engine.DeleteAsync(model.BaseModel, ct);
                }
                progress.Complete(1, $"about {model.DiskGB:0.#} GB freed");
            }

            progress.Finish($"**{model.Name}** is uninstalled. Type **/install model {model.Version}** to install it again.");
        }
        catch (EngineException ex) when (ex.Code is null)
        {
            throw new EngineException(progress.Fail(ex.Message));
        }
    }

    /// <summary>Step checklist plus a log of the commands run, rendered as Markdown for the chat.</summary>
    private sealed class StepProgress(string title, Action<string> report, params string[] steps)
    {
        private enum State { Waiting, Running, Done, Failed }

        private readonly State[] states = new State[steps.Length];
        private readonly string?[] details = new string?[steps.Length];
        private readonly List<string> log = [];
        private string? footer;

        public void Start(int step, string? detail = null) => Set(step, State.Running, detail);
        public void Detail(int step, string detail) => Set(step, states[step], detail);
        public void Complete(int step, string? detail = null) => Set(step, State.Done, detail);

        public void Log(string command)
        {
            log.Add("> " + command);
            report(Render());
        }

        public void Finish(string message)
        {
            footer = message;
            report(Render());
        }

        public string Fail(string message)
        {
            int running = Array.IndexOf(states, State.Running);
            if (running >= 0) states[running] = State.Failed;
            footer = message;
            return Render();
        }

        private void Set(int step, State state, string? detail)
        {
            states[step] = state;
            details[step] = detail;
            report(Render());
        }

        private string Render()
        {
            int current = Array.FindIndex(states, s => s is State.Running or State.Failed);
            int stepNumber = current >= 0 ? current + 1 : Array.FindLastIndex(states, s => s == State.Done) + 1;

            var text = new StringBuilder($"{title} · Step {stepNumber} of {steps.Length}\n\n");
            for (int i = 0; i < steps.Length; i++)
            {
                string mark = states[i] switch
                {
                    State.Done => "✓",
                    State.Running => "▶",
                    State.Failed => "✗",
                    _ => "○",
                };
                text.Append($"- {mark} {steps[i]}");
                if (details[i] is { } detail) text.Append($": {detail}");
                text.Append('\n');
            }
            if (log.Count > 0) text.Append("\n```\n").Append(string.Join("\n", log)).Append("\n```\n");
            if (footer is not null) text.Append('\n').Append(footer);
            return text.ToString();
        }
    }
}
