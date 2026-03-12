# REXX Control Flow

REXX Control Flow is a VS Code extension that visualizes a procedure-level call graph for REXX and layers control-flow diagnostics on top of it.

## Features

- Generate an interactive call graph from the active REXX editor.
- Auto-refresh the graph when source content changes or is saved.
- Show diagnostics for undefined labels, unreachable procedures, recursive cycles, dead code after unconditional exits, and likely loop risks.
- Show per-procedure complexity and fan-in/fan-out metrics.
- Search, filter, group, and collapse large graphs.
- Persist graph UI state such as zoom, filters, focus mode, and group selection while the webview stays open.
- Keep graph and editor in sync:
  - Selecting a function in the editor moves focus/highlighting in the graph.
  - Clicking a graph node jumps to the function line in the editor.
- Dynamic line highlighting:
  - Selecting a caller highlights its outgoing call lines.
  - If selected function has no outgoing calls, incoming call lines are highlighted.
- Signal handlers are visually distinct:
  - `SIGNAL ON ... NAME handler` targets are shown as red boxes.
- External LINKMVS program calls are visually distinct:
  - `ADDRESS LINKMVS "program"` adds a blue external-program node using the quoted program name.
- Unused procedures are highlighted
  - Shows procedures not used
- Built-in graph navigation tools:
  - Scroll/trackpad zoom in the graph canvas.
  - Reset zoom button.
  - Mouse panning
  - Back/forward history and focused-procedure mode
  - JSON, DOT, Excalidraw, SVG, and PNG export buttons in the graph view.
- Export call graph data:
  - JSON export.
  - DOT export (Graphviz format).
  - Excalidraw export opened as an untitled `.excalidraw` document.

## Supported graph constructs

- Labels (`label:`) as function entries
- `CALL label` as function-to-function edges
- Function-style expression calls such as `Func(...)`, including calls to labels defined later in the file
- Negated expression calls such as `\Func(...)`
- Dynamic calls (`CALL VALUE ...`, `CALL (...)`) grouped as `DYNAMIC_CALL`
- `SIGNAL ON ... NAME handler` as `signal-on` edges and signal-handler node tagging
- `ADDRESS LINKMVS "program"` / `ADDRESS LINKMVS 'program'` as `external-call` edges to external-program nodes
- Multiple statements per line separated by `;` (quote-aware splitting)
- Block/in-line comment stripping for parsing


## Usage

1. Open a REXX file.
2. Right-click in the editor.
3. Run **Generate REXX Control Flow**.

From the command palette, you can also run:

- **REXX Control Flow: Export REXX Control Flow to JSON**
- **REXX Control Flow: Export REXX Control Flow to DOT**
- **REXX Control Flow: Export REXX Control Flow to Excalidraw**

Right-click editor context menu focuses on graph generation (export actions are in the graph toolbar).

## Graph behavior details

- Node color:
  - Standard functions: neutral styling
  - Signal handlers (`SIGNAL ON ... NAME ...`): red styling
  - External LINKMVS programs: blue styling
- Edge color:
  - Calls are colored by target function for easier visual grouping
- Selection behavior:
  - Click node once to focus and highlight relevant call lines
  - Click another node to switch highlighted relationship context
- Graph controls:
  - Filter calls, signals, external calls, and dynamic calls
  - Group by logical section, recursion cycle, node kind, or file
  - Collapse/expand groups for large programs

## Settings

- `rexxFlow.customCssFile`: Optional path to a `.css` file that overrides the graph webview look and feel. Use an absolute path or a workspace-relative path.
- `rexxFlow.defaultView`: Choose whether the webview opens in `graph` mode or `detailed` mode. Graph mode keeps diagnostics and advanced controls collapsed by default.

## Exports

- JSON: Raw node/edge data for tooling or automation.
- DOT: Use with Graphviz tools (`dot`, `neato`, etc.).
- Excalidraw: Produces Excalidraw JSON in `.excalidraw` format.
- All exports use a Save dialog with defaults from the active REXX file:
  - default folder: same folder as the source REXX file
  - default file name: source file base name
  - extension set by export type (`.json`, `.dot`, `.excalidraw`, `.svg`, `.png`)

## Notes

- The main canvas is still a higher-level procedure/call graph, not a full rendered statement-by-statement CFG.
- Diagnostics now use additional statement-level analysis inside each procedure to detect dead code and some loop/exit risks.
- Supported file/language IDs: `rexx`, `REXX`, and common file extensions (`.rexx`, `.rex`, `.exec`).
