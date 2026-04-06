# Changelog

## 0.1.13
- Fixed horizontal scroll bug

## 0.1.12
- Added a feature to detect TSO calls in double-quotes (")

## 0.1.11
- Added new help
- Fixed an edge case for uncalled code (EXIT before a RETURN)

## 0.1.10

- Removed DOT and Excalidraw export options from the editor right-click menu.
- Added graph toolbar buttons for `Export DOT` and `Export Excalidraw` (alongside existing SVG/PNG export).
- Export actions now open a Save dialog with defaults based on the active REXX file:
  - default folder is the source file's folder
  - default filename uses the source base name
  - extension is set by export type (`.json`, `.dot`, `.excalidraw`, `.svg`, `.png`)
- SVG/PNG exports now use VS Code save flow instead of browser-style downloads.

## 0.1.9

- Added `SIGNAL ON ... NAME handler` detection and signal-handler tagging in the call graph.
- Signal-handler function boxes are now highlighted in red to visually distinguish trap routines.

## 0.1.8

- Improved graph highlighting behavior: selecting a function now highlights outgoing calls, and if none exist it highlights incoming calls so called utilities like `Prompt` and `IsNumeric` still show linked lines.
- Increased dimmed-edge visibility to keep line context visible during selection.

## 0.1.7

- Improved function-style call detection so expression calls (for example `Prompt(...)`, `MainMenu()`, `Timestamp()`, `\IsDDAllocated(...)`, `\IsYYYYMMDD(...)`, and `\IsNumeric(...)`) are included in the call graph.

## 0.1.6

- Added Excalidraw export command that preserves function-node connections as bound arrows.

## 0.1.0

- Initial REXX-specific control-flow extension.
- Added graph visualization in a webview.
- Added JSON and DOT export commands.
