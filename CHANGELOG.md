# Changelog

## 0.1.14

- Added the new interactive graph view with left module navigation, central canvas, and right inspector.
- Added workspace graph generation across supported REXX files.
- Added VS Code Problems diagnostics and CodeLens shortcuts.
- Added safer custom CSS loading with `.css` validation, workspace-trust handling, and a 64 KB size limit.
- Updated the Broadcom custom CSS sample for the new graph view selectors.
- Added TSO command detection for paired double-quoted command strings, including continued text across lines.
- Added 80-column line-length diagnostics.
- Added right-click graph exports for JSON, DOT, Excalidraw, SVG, and PNG.
- Added right-click **Allow Node Movement**, **Disable Node Movement**, and **Reset View** actions.
- Persisted moved node positions across subsequent renders.
- Fixed node movement so dragging stops when the mouse button is released or the webview loses focus.
- Fixed search so typing no longer steals focus from the search input.
- Removed compact/regular/comfy density controls; the graph always starts and stays at regular spacing.
- Added red highlighting and legend support for functions not called by another node.
- Updated node selection so left panel, main graph, and right inspector stay synchronized.

## 0.1.13

- Fixed horizontal scroll behavior in the graph view.

## 0.1.12

- Removed `Export REXX Control Flow to JSON` from the editor right-click menu.
- Added detection for TSO calls in double-quoted command strings.

## 0.1.11

- Export actions now open a Save dialog with defaults based on the active REXX file:
  - default folder is the source file's folder
  - default filename uses the source base name
  - extension is set by export type (`.json`, `.dot`, `.excalidraw`, `.svg`, `.png`)
- SVG/PNG exports now use VS Code save flow instead of browser-style downloads.

## 0.1.10

- Removed DOT and Excalidraw export options from the editor right-click menu.
- Added graph toolbar buttons for `Export DOT` and `Export Excalidraw` alongside existing SVG/PNG export.

## 0.1.9

- Added `SIGNAL ON ... NAME handler` detection and signal-handler tagging in the call graph.
- Signal-handler function boxes are now highlighted in red to visually distinguish trap routines.

## 0.1.8

- Improved graph highlighting behavior: selecting a function now highlights outgoing calls, and if none exist it highlights incoming calls so called utilities like `Prompt` and `IsNumeric` still show linked lines.
- Increased dimmed-edge visibility to keep line context visible during selection.

## 0.1.7

- Improved function-style call detection so expression calls are included in the call graph.

## 0.1.6

- Added Excalidraw export command that preserves function-node connections as bound arrows.

## 0.1.0

- Initial REXX-specific control-flow extension.
- Added graph visualization in a webview.
- Added JSON and DOT export commands.
