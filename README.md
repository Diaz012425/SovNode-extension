# SovNode

**An AI coding agent for VS Code.** Chat with Gemini, Anthropic Claude or OpenAI models
right in the sidebar — they read your whole project through a real repo map, edit or
create files directly on disk, and auto-commit each change so nothing you had is ever
at risk.

<!-- TODO: badges — paste your Marketplace publisher/extension id here, e.g.:
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/<publisher>.<name>?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=<publisher>.<name>)
-->
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---
## See it in action

| From one prompt to a working project | Live iteration on a running app | Improving existing code |
|---|---|---|
| ![Scaffolding a project from scratch](docs/3%20creating%20a%20project.gif) | ![Iterating live on a canvas app](docs/1%20make%20the%20code.gif) | ![Improving existing code](docs/2%20improve%20the%20code.gif) |

## Why SovNode

Most AI chat panels can only *suggest* code for you to copy and paste. SovNode acts
directly on your project:

- **It sees your whole codebase.** A real repo map (tree-sitter, 8 languages) with
  function/class signatures and a PageRank-ranked view of what matters, weighted
  toward the files you already have open.
- **It writes to disk, not just to the chat.** Edits land as SEARCH/REPLACE blocks,
  unified diffs, or full-file rewrites — whichever format the model you picked
  handles best.
- **It never leaves you stranded.** Every applied change is auto-committed (one
  commit per turn, only the files touched), and `/undo` (or `/undo task` for a whole
  multi-step task) rolls it straight back.
- **It checks its own work.** After writing, SovNode verifies the touched files still
  parse/compile — and can run your own test command — before committing; if
  something's broken, the model gets a shot at fixing it automatically.
- **It costs what it says.** Exact per-call and per-turn cost in USD (including
  cache reads/writes), logged to a usage file you can open any time.

## Features

| Feature | What it does |
|---|---|
| Multi-provider | The model name picks the provider on its own: `gemini-*` → Gemini, `gpt-*`/`o<n>-*` → OpenAI, `claude-*` → Anthropic. Each provider uses its own API key. |
| Architect mode | A strong model plans first (no code), a cheaper model implements it — useful for larger, multi-file changes. |
| Agent mode / `/task` | Splits a request into steps and runs them one after another, retrying on real errors and replanning if it gets stuck. |
| Repo map | Real signatures across your project via tree-sitter, not a flat file dump. |
| Focused context | Large files are sent as just the relevant functions/selection plus an index, not the whole thing. |
| Native tools | The model can request to read a file, search the repo, or run a command mid-turn, through the provider's native tool-calling. |
| Error log attach | Paste a stack trace, terminal output, or a Problems-panel entry as a standing log the model sees every turn until you clear it — secrets get scrubbed automatically. |
| Git auto-commit + `/undo` | Every applied change is one commit; undo it (or a whole task) at any time. |
| Verification | Touched files are checked to still parse/compile, plus your own test command if you set one. |
| Cost tracking | Per-call and per-turn USD cost, streamed live and logged. |
| Bilingual UI | Follows VS Code's own display language (Spanish/English), or set it explicitly. |

## Getting started

Not on the Marketplace yet, but installing from source is quick:

1. **Download this repo** as a ZIP (green "Code" button → "Download ZIP") and unzip
   it, or `git clone` it.
2. Open a terminal inside the unzipped folder and run:
   ```
   npm install
   npm install -g @vscode/vsce
   vsce package
   ```
   This creates a `.vsix` file (e.g. `sovnode-vsextension-0.29.4.vsix`) in the same
   folder.
3. Install it in VS Code: Extensions panel (Ctrl+Shift+X) → "..." menu (top right)
   → **Install from VSIX...** → pick the file you just created. (Or from a
   terminal: `code --install-extension sovnode-vsextension-0.29.4.vsix`.)
4. Open the SovNode icon (◆) in the Activity Bar.
5. Set an API key for at least one provider (🔑 button, or *SovNode: Set API Key*).
6. Type what you want built or changed — SovNode reads your active file and project
   context automatically.

No account, no server: your API keys are stored locally and every request goes
straight from your machine to the provider you chose.

## Configuration

The most commonly used settings (`sovnodeAider.*` in VS Code settings):

| Setting | Purpose |
|---|---|
| `model` | Model for the main turn (or `auto` to let SovNode pick by tier). |
| `architect` | Turn architect mode on/off. |
| `editorModel` | Model that writes the code in architect mode. |
| `editFormat` | `auto` / `search-replace` / `udiff` / `whole`. |
| `verify`, `verifyCommand` | Auto-check + optional test command after every change. |
| `autoCommit` | Commit each applied change automatically. |
| `execEnabled`, `execAllowlist` | Let the model run commands mid-turn, with your approval. |
| `taskBudgetUSD` | Spending cap per `/task`, with a prompt to continue past it. |

See the full list of settings and their descriptions directly in VS Code
(Settings → search "SovNode").

## License

MIT — see [LICENSE](LICENSE).

