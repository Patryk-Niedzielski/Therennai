using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;

namespace Therennai;

/// <summary>
/// Installs a new Therennai release from GitHub. Only the program files next to the exe are replaced;
/// chats, memory and settings live in %LOCALAPPDATA%\Therennai and the models live with the engine, so they're kept.
/// </summary>
internal static class Updater
{
    /// <summary>The release asset the updater installs; tools/release.ps1 creates it.</summary>
    public const string AssetName = "Therennai-win-x64.zip";

    private const string DownloadPrefix = "https://github.com/Patryk-Niedzielski/Therennai/releases/download/";

    /// <summary>Only downloads from Therennai's own GitHub releases are installed.</summary>
    public static bool IsTrustedDownload(string url) => url.StartsWith(DownloadPrefix, StringComparison.Ordinal);

    /// <summary>Downloads and unpacks the release, returning the folder with the new program files.</summary>
    public static async Task<string> DownloadAsync(string url, string? sha256, Action<int> onPercent, CancellationToken ct)
    {
        string work = Path.Combine(Path.GetTempPath(), "therennai-update-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        string zip = Path.Combine(work, AssetName);

        using (var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan })
        {
            http.DefaultRequestHeaders.UserAgent.ParseAdd("Therennai");
            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();
            long total = response.Content.Headers.ContentLength ?? 0;

            await using var input = await response.Content.ReadAsStreamAsync(ct);
            await using var output = File.Create(zip);
            var buffer = new byte[81920];
            long done = 0;
            int lastPercent = -1;
            int read;
            while ((read = await input.ReadAsync(buffer, ct)) > 0)
            {
                await output.WriteAsync(buffer.AsMemory(0, read), ct);
                done += read;
                int percent = total > 0 ? (int)(done * 100 / total) : -1;
                if (percent != lastPercent)
                {
                    lastPercent = percent;
                    onPercent(percent);
                }
            }
        }

        if (!string.IsNullOrEmpty(sha256))
        {
            await using var file = File.OpenRead(zip);
            string actual = Convert.ToHexString(await SHA256.HashDataAsync(file, ct));
            if (!actual.Equals(sha256, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The download is damaged. Try updating again.");
        }

        string staging = Path.Combine(work, "app");
        ZipFile.ExtractToDirectory(zip, staging);
        File.Delete(zip);
        if (!File.Exists(Path.Combine(staging, "Therennai.exe")))
            throw new IOException("The update package is incomplete.");
        return staging;
    }

    /// <summary>
    /// Starts a helper that waits for Therennai to close, copies the new files over the old ones and opens it again.
    /// The caller closes the app right after.
    /// </summary>
    public static void ScheduleInstall(string staging)
    {
        string script = Path.Combine(Path.GetDirectoryName(staging)!, "apply-update.ps1");
        File.WriteAllText(script, ApplyScript);
        string target = AppContext.BaseDirectory.TrimEnd('\\');

        Process.Start(new ProcessStartInfo("powershell.exe",
            $"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{script}\" " +
            $"-AppPid {Environment.ProcessId} -Source \"{staging}\" -Target \"{target}\"")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        })?.Dispose();
    }

    private const string ApplyScript = """
        param([int]$AppPid, [string]$Source, [string]$Target)

        $log = Join-Path $env:TEMP "therennai-update.log"
        Wait-Process -Id $AppPid -Timeout 60 -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500

        try {
            # Copy the new program files over the old ones (retrying while files are still being released).
            robocopy $Source $Target /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "Copying the new files failed (robocopy $LASTEXITCODE)." }

            # Point the desktop shortcut at the new icon; Windows caches icons by file path.
            $exe = Join-Path $Target "Therennai.exe"
            $icon = Join-Path $Target "icon.ico"
            $link = Join-Path ([Environment]::GetFolderPath("Desktop")) "Therennai.lnk"
            if ((Test-Path $icon) -and (Test-Path $link)) {
                $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
                if ($shortcut.TargetPath -eq $exe) {
                    $hash = (Get-FileHash $icon -Algorithm SHA256).Hash.Substring(0, 8).ToLower()
                    $named = Join-Path $Target "icon-$hash.ico"
                    if (-not (Test-Path $named)) {
                        Get-ChildItem $Target -Filter "icon-*.ico" | Remove-Item -ErrorAction SilentlyContinue
                        Copy-Item $icon $named
                    }
                    $shortcut.IconLocation = "$named,0"
                    $shortcut.Save()
                }
            }
        }
        catch {
            "$(Get-Date -Format s) $_" | Out-File $log -Append
        }

        Start-Process (Join-Path $Target "Therennai.exe")
        Remove-Item (Split-Path $Source -Parent) -Recurse -Force -ErrorAction SilentlyContinue
        """;
}
