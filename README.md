# REXX Control Flow

REXX Control Flow is a VS Code extension that builds a function call graph from a REXX source file.

## Features

- Generate an interactive call graph from the active REXX editor.
- Export the graph to JSON.
- Export the graph to DOT format.
- Click graph nodes to jump to the matching source line.
- Auto-refresh the graph when the source document changes.
- Focus on function-to-function call relationships from `MAIN` and labels.

## Supported call-graph constructs

- Labels (`label:`) as function entries
- `CALL label` as function-to-function edges
- Dynamic calls (`CALL VALUE ...`, `CALL (...)`) grouped as `DYNAMIC_CALL`
- Multiple statements per line separated by `;` (quote-aware splitting)

## Usage

1. Open a REXX file.
2. Right-click in the editor.
3. Run **Generate REXX Control Flow**.

From the command palette, you can also run:

- **REXX Control Flow: Export REXX Control Flow to JSON**
- **REXX Control Flow: Export REXX Control Flow to DOT**

## Notes

This version intentionally shows a higher-level call graph instead of statement-by-statement control flow.
