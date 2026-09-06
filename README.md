# Graph_Enj

Local-first **coding-agent graph studio** and session control plane.

- **Tauri 2** desktop shell
- **React Flow** graph as source of truth
- Orchestrator = **interactive Cursor Agent in your preferred terminal** (not headless)
- Graph_Enj opens that terminal, binds the session id, and visualizes status
- Prompting happens in the real Cursor Agent TUI
- Terminal resolution: `GRAPH_ENJ_TERMINAL` → Cursor/VS Code `terminal.external.osxExec` → Launch Services (`public.unix-executable`) → common apps
- Ghostty is opened via its AppleScript API (normal shell + window size), not `open -e` script hacks

## Compliance (Cursor Agent)

Uses the **official** Cursor Agent CLI (`agent` / `cursor-agent`) for solo local use.

- Auth: `agent login` or `CURSOR_API_KEY`
- Do not call undocumented Cursor private APIs or resell Cursor access
- Product diligence, not legal advice

## Quick start

```bash
agent status
npm install
npm run tauri dev
```

In the **Graph_Enj desktop window** (not a browser tab):

1. Click **Open orchestrator session (Terminal)**
2. Your preferred terminal opens with interactive `agent` in this repo
3. Prompt in that terminal
4. Graph binds the session id when discovered under `~/.cursor/chats/<md5(cwd)>/`
5. **Mark complete** or **Detach** when done

**Smoke (headless)** under Dev is only for connectivity checks (`agent -p`).

## Architecture

1. React Flow topology is the source of truth.
2. Graph_Enj does not own a custom LLM orchestrator kernel.
3. Orchestrator node binds to a real Cursor Agent session (preferred terminal).
4. Spawner authority is appointed by the graph (`canSpawn`).
5. Demo target: this repo (`Graph_Enj`).

## Scripts

- `npm run dev` — Vite UI (no live spawn)
- `npm run build` — typecheck + Vite build
- `npm run tauri dev` — desktop app
- `npm run tauri build` — package
