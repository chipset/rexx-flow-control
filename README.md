# REXX Control Flow

REXX Control Flow is a VS Code extension that builds and visualizes a function-level call graph from a REXX source file.

## Features

- Generate an interactive call graph from the active REXX editor.
- Auto-refresh the graph when source content changes or is saved.
- Keep graph and editor in sync:
  - Selecting a function in the editor moves focus/highlighting in the graph.
  - Clicking a graph node jumps to the function line in the editor.
- Dynamic line highlighting:
  - Selecting a caller highlights its outgoing call lines.
  - If selected function has no outgoing calls, incoming call lines are highlighted.
- Signal handlers are visually distinct:
  - `SIGNAL ON ... NAME handler` targets are shown as red boxes.
- Unused procedures are highlighted
  - Shows procedures not used
- Built-in graph navigation tools:
  - Scroll/trackpad zoom in the graph canvas.
  - Reset zoom button.
  - Updated panning routine using mouse
  - Adjusted view canvase
  - JSON, DOT, Excalidraw, SVG, and PNG export buttons in the graph view.
- Export call graph data:
  - JSON export.
  - DOT export (Graphviz format).
  - Excalidraw export opened as an untitled `.excalidraw` document.

## Supported call-graph constructs

- Labels (`label:`) as function entries
- `CALL label` as function-to-function edges
- Function-style expression calls such as `Func(...)`, including calls to labels defined later in the file
- Negated expression calls such as `\Func(...)`
- Dynamic calls (`CALL VALUE ...`, `CALL (...)`) grouped as `DYNAMIC_CALL`
- `SIGNAL ON ... NAME handler` as `signal-on` edges and signal-handler node tagging
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
- Edge color:
  - Calls are colored by target function for easier visual grouping
- Selection behavior:
  - Click node once to focus and highlight relevant call lines
  - Click another node to switch highlighted relationship context

## Settings

- `rexxFlow.customCssFile`: Optional path to a `.css` file that overrides the graph webview look and feel. Use an absolute path or a workspace-relative path.

## Exports

- JSON: Raw node/edge data for tooling or automation.
- DOT: Use with Graphviz tools (`dot`, `neato`, etc.).
- Excalidraw: Produces Excalidraw JSON in `.excalidraw` format.
- All exports use a Save dialog with defaults from the active REXX file:
  - default folder: same folder as the source REXX file
  - default file name: source file base name
  - extension set by export type (`.json`, `.dot`, `.excalidraw`, `.svg`, `.png`)

## Notes

- The extension intentionally shows a higher-level function call graph rather than statement-by-statement control flow.
- Supported file/language IDs: `rexx`, `REXX`, and common file extensions (`.rexx`, `.rex`, `.exec`).
