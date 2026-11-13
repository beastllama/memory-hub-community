# Memory Hub

Pick a project folder. Review notes that point back to the source. Save the notes you want as Markdown.

Memory Hub reads selected project docs and manifests. It does not run project code or change the checkout. No Memory Hub account or AI is needed to scan, review, or save.

## Try it

Start with [Trail Notes](examples/Trail%20Notes/README.md), a fictional sample project.

1. Select **Choose a project folder**. Pick the sample or a small project you know.
2. Open a source under a note. Keep the notes you want.
3. Select **Save selected notes**. Open the saved Markdown in your editor.

To use Obsidian, choose your vault under **Change memory folder** before you save. Memory Hub writes new snapshots in a `Memory Hub` subfolder. It does not overwrite your existing notes or keep them in sync.

### Windows download

If your release includes a Windows x64 ZIP, extract the whole ZIP. Open **Start Memory Hub.cmd**. Keep the launcher window open while you use the browser app. Close it to stop the app. The ZIP includes its Node.js runtime; you do not install Node or pnpm separately. Use downloads from the project's GitHub release. Compare the published SHA-256 before you open the launcher.

If there is no ZIP, build from source.

### Build from source

Use a supported, security-patched version of Node.js 22 or later and pnpm 11.1.1. From the project folder:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm start
```

Windows is the first preview target. The app offers a native folder picker on Windows and macOS, and a path field on Linux. This is a local app. Do not deploy it to a public server or expose its port to the network.

## What stays on your device

- The normal scan, review, and save flow does not send project content to an AI provider. Only folders you select are scanned. The app scans selected docs and manifests, not Git history.
- Local state includes project paths, source excerpts, selections, and drafts. It is not encrypted by the app. On Windows it is stored in `%LOCALAPPDATA%\Memory Hub`. On macOS it is in `~/Library/Application Support/Memory Hub`. On Linux it is in `~/.local/share/memory-hub`. Your folders or vault may be synced by other software.
- Use a sample or a project you trust. Secret detection is limited. Do not share app state, notes, terminal output, or screenshots without checking them first.

## Optional AI drafting

Select **Check for Codex** to look for a supported local Codex install. The preview supports one reviewed Windows CLI build (0.153.4). Other builds fail closed. Pick a model from your own account. Select **Draft notes with Codex** to preview the excerpts. Only **Send to Codex** sends them to your provider. AI usage comes from your account. Memory Hub provides no inference or API key.

Use **Use another AI manually** to review and copy a prompt to another tool. AI suggestions need a matching source quote, but that does not make every claim correct. No assistant's native memory is updated.

## Checks and feedback

Run `pnpm verify` for formatting, type checks, tests, and the build. Unit tests use fixtures, not live AI. Report bugs with the app version, operating system, and steps to reproduce on the sample. Remove local paths and private project details. Never attach a raw log, project file, or credential.
