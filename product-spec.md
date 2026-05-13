# REXX Control Flow — Product Specification

## 1. Product Summary

### Product name
**REXX Control Flow**

### Product type
Visual Studio Code extension

### Value proposition
Visualize and inspect REXX procedure-level control flow with an interactive graph, native diagnostics, and export tooling for both single files and multi-file workspaces.

### Product status
Feature-rich, test-backed, and shippable, with known limitations around full cross-file semantic resolution.

---

## 2. Problem Statement

REXX programs can be difficult to understand because:
- procedure flow is label-driven
- call relationships are not visually obvious
- issues such as undefined labels, dead code, and loop risks are easy to miss
- larger codebases need both visual understanding and editor-native issue surfacing

The extension exists to help users move from “open unfamiliar REXX code” to “understand structure and risk” as quickly as possible.

---

## 3. Goals

### Primary goals
1. Help users understand REXX procedure structure quickly
2. Surface likely control-flow defects and code-quality risks
3. Provide an interactive visual graph for navigation and analysis
4. Support both single-file and workspace-wide inspection
5. Offer export formats suitable for tooling, reporting, and diagram workflows

### Secondary goals
1. Integrate naturally with native VS Code workflows
2. Preserve graph UI state across panel recreation
3. Keep the extension local-only and operationally simple

### Non-goals
1. Executing REXX programs
2. Acting as a compiler or semantic verifier
3. Providing cloud-backed or authenticated analysis
4. Full whole-program cross-file symbol resolution

---

## 4. Target Users

### Primary users
- Developers maintaining REXX code in VS Code
- Engineers analyzing legacy or mainframe-oriented REXX codebases
- Users who need fast visual orientation in unfamiliar REXX programs

### Secondary users
- Teams who want exportable graph artifacts
- Users integrating graph output into documentation or automation

---

## 5. User Stories

1. **As a developer**, I want to generate a graph from the active REXX file so that I can understand its procedures and calls.
2. **As a maintainer**, I want diagnostics in the Problems panel so that likely issues are visible in normal editor workflows.
3. **As a user of multi-file codebases**, I want a workspace-wide graph so that I can inspect relationships across files.
4. **As a user navigating code visually**, I want graph-node clicks to jump to source lines so that I can move between graph and code efficiently.
5. **As a user documenting systems**, I want export formats like JSON, DOT, Excalidraw, SVG, and PNG so that I can reuse graph output outside VS Code.

---

## 6. Feature Set

### 6.1 Single-file graph generation
Users can generate an interactive graph from the active supported REXX document.

Behavior:
- opens a dedicated webview panel for the document
- preserves one graph panel per document session
- re-renders on edit/save
- keeps graph state connected to editor navigation

### 6.2 Workspace graph generation
Users can generate a workspace-wide graph across supported REXX files in the current workspace.

Behavior:
- scans supported workspace files
- aggregates per-file parser results
- adds a synthetic workspace root
- displays grouped file-level and inferred cross-file information

### 6.3 Problems-panel diagnostics
The extension publishes diagnostics to the VS Code Problems panel.

Supported categories:
- undefined labels
- unreachable procedures
- cleanup bypass risks
- possible infinite loop risks
- dead code
- line-length warnings

### 6.4 Interactive graph navigation
The graph UI supports:
- node selection
- synchronized left-panel, graph, and inspector selection
- search highlighting
- history back/forward
- zoom in/out/fit
- mouse panning
- grouping and collapse/expand
- edge filtering
- graph-only and detailed modes
- right-click export actions
- opt-in node movement and reset view

### 6.5 Graph/editor synchronization
- editor selection updates graph focus
- graph-node interaction reveals source lines
- graph-node selection updates the left module panel and right inspector
- workspace graph nodes can open the correct file and line

### 6.6 Editor-native integration
Supported REXX files expose CodeLens actions for:
- Show Control Flow
- Workspace Graph
- Export JSON
- Export PNG

### 6.7 Export support
Supported export formats:
- JSON
- DOT
- Excalidraw
- SVG
- PNG

Exports are available from:
- command palette
- graph webview controls

### 6.8 UI persistence
The extension persists graph UI state across panel recreation, including:
- selected caller
- zoom level
- search term
- group mode
- collapsed groups
- active filters
- history state
- view mode
- moved node positions

---

## 7. Workspace Graph Semantics

### Current model
Workspace graphs are built by aggregating per-file parser outputs.

### Guarantees
- all supported workspace files can be included
- nodes are grouped by file
- per-file analysis is preserved
- a subset of cross-file relationships can be inferred incrementally

### Current limitation
Workspace graphs are **not** full semantic whole-program resolution.

Users should treat cross-file links as:
- useful inferred relationships
- not compiler-grade truth

---

## 8. Commands

The extension contributes:

1. `rexxFlow.showControlGraph`
2. `rexxFlow.showWorkspaceControlGraph`
3. `rexxFlow.exportGraphJson`
4. `rexxFlow.exportDot`
5. `rexxFlow.exportExcalidraw`
6. `rexxFlow.exportSvg`
7. `rexxFlow.exportPng`

Context-menu contribution:
- `rexxFlow.showControlGraph` on supported REXX editors

---

## 9. Configuration

### `rexxFlow.customCssFile`
Purpose:
- allow custom restyling of the graph webview

Behavior:
- absolute paths allowed
- workspace-relative paths allowed only in trusted workspaces
- file must be `.css`
- files larger than 64 KB are ignored
- CSS is sanitized before injection

### `rexxFlow.defaultView`
Allowed values:
- `graph`
- `detailed`

Default:
- `graph`

Purpose:
- controls whether the graph opens in graph-only or detailed mode

---

## 10. UX and Visual Design

### Graph presentation
The graph UI uses:
- a left module panel, central graph canvas, and right inspector
- card-based nodes sized to show function names
- selectable tree, layered, and radial layouts
- regular spacing without user-selectable density modes
- file-aware metadata
- visually distinct special node classes
- dashed inferred cross-file edges
- red uncalled-function highlighting when non-root functions have no incoming calls

### Modes
- **Graph mode**: focused graph view
- **Detailed mode**: graph plus diagnostics and controls

### Interaction expectations
- wide graphs remain navigable by horizontal panning and zoom
- large graphs remain searchable and groupable
- source-code navigation remains available from graph interactions

---

## 11. Success Criteria

The product is successful when:
- users can understand single-file flow faster
- likely issues surface without leaving VS Code
- workspace graphs provide useful cross-file orientation
- export formats are practical for downstream workflows
- graph state and UX remain stable across repeated use

---

## 12. Known Limitations

1. Workspace graphing is still incremental and approximate.
2. Full semantic inter-file resolution is not implemented.
3. The real extension-host harness is heavier than local Node tests.
4. The largest remaining complexity surface is the graph webview runtime.

---

## 13. Future Opportunities

Potential future work:
- tree/sidebar navigation
- code actions for diagnostics
- stronger inter-file semantic resolution
- richer editor-native workflows
- further decomposition of the webview rendering/runtime module

---

## 14. Release Readiness Summary

The current product delivers:
- interactive single-file graphing
- workspace graph aggregation
- native Problems-panel diagnostics
- multiple export formats
- editor synchronization
- CodeLens shortcuts
- UI persistence
- CI-backed verification and extension-host harness support

The main remaining product-level caveat is that workspace relationships are still inferred rather than fully semantically resolved.

---

## 15. Release Scope and Roadmap

### Current release scope
The current release includes:
- single-file graph generation
- workspace graph generation
- Problems-panel diagnostics
- command-palette and toolbar exports
- workspace-backed graph UI persistence
- CodeLens shortcuts
- CI-backed verification and extension-host harness wiring

### Near-term roadmap

#### Phase 1 — Trust and correctness
- Clarify workspace graph semantics in docs and UX copy
- Improve incremental cross-file inference where safe and testable
- Tighten verification expectations for the real VS Code harness

#### Phase 2 — Maintainability
- Further split the large webview rendering/runtime layer
- Reduce regression risk in future UI and export work
- Keep packaging and verification aligned with the modular structure

#### Phase 3 — Editor-native UX
- Add richer editor-native workflows beyond current CodeLens coverage
- Evaluate code actions and stronger diagnostic navigation affordances
- Reassess whether a tree/sidebar view is justified by user value and maintenance cost

### Deferred / long-term work
- Full semantic inter-file resolution
- Whole-program analysis beyond incremental inference
- Heavier navigation surfaces such as a dedicated sidebar/tree workflow
