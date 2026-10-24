# Therennai

Therennai is an open-source AI agent that runs locally on your own computer. Your chats never leave your PC.

This repository has the Windows desktop app, `Therennai.exe`: a chat window with a sidebar of recent chats, a message box with slash commands, a context meter, a permissions button and a model picker. Its model, **Vesper 1.0**, is built on Gemma 3 4B and runs entirely on your PC, on the GPU when there's room.

## Features

- **Local chat** with streamed replies, formatted answers, and a stop button
- **Slash commands** like Claude Code and Codex: type `/` to see them (see [Commands](#commands))
- **One-command model installs**: `/install model 1.0` sets everything up and shows each step as it runs
- **Context meter and compacting**: see how full the chat is, compact it with one click, or let Therennai compact it automatically
- **Memory**: notes Therennai remembers in every chat
- **Settings**: theme, model, permissions, memory and chat data in one place
- **Updates**: Therennai checks GitHub for new releases and installs them in place, keeping your chats
- **Native window** with rounded corners, a custom title bar, light and dark themes

## Requirements

- Windows 10 or 11
- [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) to build
- Microsoft Edge WebView2 Runtime (already included with Windows 11 and most up-to-date Windows 10 PCs)
- About 8 GB of free disk space for the model. A GPU with 6 GB or more makes replies fast.

## Build and install

In PowerShell, from the repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

This builds `dist\Therennai.exe` and puts a **Therennai** shortcut on your desktop.

Then open Therennai and type **/install model 1.0** in the chat. Therennai shows a checklist of the install steps and a log of the commands it runs. The first install also sets up the local model engine in the background. You can also install from PowerShell with `install-brain.ps1`.

## Commands

Type `/` in the message box to see them. Use the arrow keys and Tab or Enter to pick one, or type `/help`.

| Command | What it does |
|---|---|
| `/help` | Lists all commands |
| `/new` | Starts a new chat |
| `/clear` | Clears the current chat's messages |
| `/model [version]` | Shows the models, or switches to one, e.g. `/model 1.0` |
| `/permissions [mode]` (`/approvals`) | Shows the permission modes, or sets one: `chat`, `ask`, `files`, `full` |
| `/install model <version>` | Installs one model, e.g. `/install model 1.0` |
| `/install model all` | Installs every model |
| `/uninstall model <version>` | Removes one model and frees its disk space, e.g. `/uninstall model 1.0` |
| `/uninstall model all` | Removes every model |
| `/status` | Shows the model, permissions, engine, memory use, GPU and disk space |
| `/doctor` | Checks that the app, engine, models, GPU and disk are all OK |
| `/context` | Shows how much of the model's context window the chat uses |
| `/compact` | Replaces the chat with a summary to free up context |
| `/memory [add <text> \| forget <n> \| clear]` | Things Therennai remembers in every chat |
| `/rewind` | Removes your last message and its reply |
| `/resume [number]` | Lists earlier chats, or opens one |
| `/rename <title>` | Renames the current chat |
| `/export` | Saves the chat as a Markdown file |
| `/theme [system \| light \| dark]` | Changes the theme (with no argument, cycles through them) |
| `/bug` (`/feedback`) | Opens a new GitHub issue |
| `/exit` (`/quit`) | Closes Therennai |

Commands for coding agents, such as `/init`, `/review`, `/diff`, `/mcp` and `/agents`, will come once Therennai can act on your PC.

## Context

Vesper 1.0 has a 16,384-token context window, the largest that fits fully on a 6 GB GPU. The ring next to the model picker shows how much of it the current chat uses; click it for details. The button beside it compacts the chat: Therennai replaces the chat with a summary to free up space. When a chat reaches 85%, Therennai compacts it automatically before sending your next message.

## Permissions

The shield button next to the model picker sets what Therennai may do on your PC: **Chat only**, **Ask every time**, **Auto-approve files** or **Full access**. Tools for acting on the PC aren't built yet, so for now every mode only chats.

## Settings and updates

The two buttons at the bottom of the sidebar:

- **Settings** (gear): theme, model, permissions, memory, deleting all chats, and the app version.
- **Check for updates** (circular arrows): looks for a newer release of Therennai on GitHub. Therennai also checks quietly a few seconds after it opens.

When a newer version exists, Therennai shows what's new with **Update now** and **Later**. **Update now** downloads the release, checks the download isn't damaged, closes Therennai, replaces the program files and opens it again. Chats, memory and settings are stored in `%LOCALAPPDATA%\Therennai` and the models with the engine, so an update never touches them.

## Privacy

Chats, memory and settings stay on your PC in `%LOCALAPPDATA%\Therennai`. Therennai only goes online to download a model (`/install`) and to check this repository's GitHub releases for updates.

## Publishing a release

1. Raise `<Version>` in `src/Therennai/Therennai.csproj`, e.g. to `1.1.0`.
2. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Publish -Notes "What's new in this version"
   ```

   This builds `release\Therennai-win-x64.zip` and creates the GitHub release `v1.1.0` with it, using the GitHub CLI (`gh`). Without `-Publish` it only builds the zip.

Installed copies of Therennai offer the update the next time they check.

## Project layout

| Path | Purpose |
|---|---|
| `src/Therennai/MainForm.cs` | The native window (rounded corners, custom title bar); passes chats between the interface and the model |
| `src/Therennai/ModelEngine.cs` | Starts the local model engine when needed, preloads the model and streams replies |
| `src/Therennai/ModelInstaller.cs` | The `/install` and `/uninstall` commands: steps and progress |
| `src/Therennai/Updater.cs` | Downloads a release and swaps in the new program files, keeping chats |
| `ui/` | Interface: layout, styling, chats, commands, settings (`MODELS`, `PERMISSIONS` and `COMMANDS` in `app.js`) |
| `models/therennai-1.0/system.txt` | Vesper 1.0's instructions: personality and how it behaves |
| `models/therennai-1.0/Modelfile` | Vesper 1.0's base model and generation settings |
| `models/therennai-1.0/model.json` | Name, version, disk size and context window, used by the app and `/install` |
| `ui/icon.svg`, `assets/icon.ico` | App icon; `tools/make-icon.ps1` renders the `.ico` from the SVG |
| `install.ps1`, `install-brain.ps1` | Build the app and desktop shortcut; set up the model from PowerShell |
| `tools/release.ps1` | Packages (and optionally publishes) a release for the updater |

## Teaching Therennai

Edit `models/therennai-1.0/system.txt` to change how Vesper behaves, then run `install.ps1` again. To change the base model or settings, edit the `Modelfile`, then run `/uninstall model 1.0` and `/install model 1.0` in the app (or `install-brain.ps1`).

## License

Therennai's code is [MIT](LICENSE) licensed. The Gemma 3 base model is covered by Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
