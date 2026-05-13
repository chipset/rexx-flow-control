# REXX Control Flow — Technical Design Specification

## 1. Technical Overview

REXX Control Flow is a local-only VS Code extension that:
- parses supported REXX source files
- builds procedure-level graph and analysis data
- renders that data in a custom webview
- publishes selected analysis findings as native VS Code diagnostics
- supports single-file and workspace-wide sessions

The design is optimized for:
- local execution
- lightweight deployment
- bounded trust surfaces
- strong automated verification

---

## 2. Runtime and Packaging

### Runtime
- VS Code extension host
- Node-based host code
- Webview-based graph UI

### Engine requirement
- `^1.91.0`

### Distributed artifact
- VSIX package

### Packaged files
- `extension.js`
- `parser.js`
- `lib/shared.js`
- `lib/host-analysis.js`
- `lib/webview.js`
- `lib/webview-render.js`
- `lib/webview-support.js`
- docs and image assets

---

## 3. Module Architecture

### 3.1 `extension.js`
Responsibilities:
- activation
- command registration
- session creation and lifecycle
- graph caching
- diagnostics refresh orchestration
- persistence integration
- export routing
- workspace graph command wiring

### 3.2 `parser.js`
Responsibilities:
- parse REXX source into graph nodes and edges
- compute analysis metadata
- serialize to DOT
- serialize to Excalidraw

### 3.3 `lib/shared.js`
Responsibilities:
- nonce generation
- CSP creation
- webview message normalization
- persisted-state normalization
- webview option creation

### 3.4 `lib/host-analysis.js`
Responsibilities:
- create line ranges for diagnostics
- build diagnostics from graph analysis
- build workspace graph aggregation
- perform incremental cross-file inference
- recompute workspace reachability/orphan state

### 3.5 `lib/webview-render.js`
Responsibilities:
- generate the full webview HTML
- embed graph UI runtime logic
- handle filtering, grouping, zoom, panning, persistence messaging, and export triggers

### 3.6 `lib/webview-support.js`
Responsibilities:
- render support utilities
- node and edge class helpers
- diagnostics panel HTML
- metric card rendering
- HTML escaping/serialization helpers

### 3.7 `lib/webview.js`
Responsibilities:
- facade exports for host code

---

## 4. Parsing and Analysis Model

## 4.1 Parser Inputs
Input:
- raw REXX source text

Output:
- `nodes`
- `edges`
- `analysis`

### 4.2 Parsing scope
The parser is:
- statement-aware
- procedure-level
- quote-aware for statement splitting
- comment-aware for block and inline stripping

### 4.3 Supported constructs
- labels as function entries
- `CALL label`
- function-style invocation `Func(...)`
- negated function-style invocation `\Func(...)`
- dynamic calls:
  - `CALL VALUE ...`
  - `CALL (...)`
- `SIGNAL ON ... NAME handler`
- `ADDRESS LINKMVS ...`
- TSO command strings
- semicolon-separated multi-statement lines

### 4.4 Node model
Representative node kinds:
- `entry`
- `function`
- `reference`
- `external-program`
- `tso-command`
- `dynamic-call`
- `workspace-root`
- `file-entry`

### 4.5 Edge model
Representative edge types:
- `calls`
- `calls-dynamic`
- `signal-on`
- `external-call`
- `tso-call`
- `workspace`
- `calls-cross-file`

### 4.6 Analysis outputs
The parser computes:
- undefined labels
- suspicious call targets
- unreachable procedures
- orphan procedures
- recursive cycles
- possible infinite loops
- dead code statements
- cleanup bypass risks
- line-length warnings
- complexity metrics
- per-procedure analysis details
- grouping metadata by file, kind, section, cycle

---

## 5. Workspace Graph Design

### 5.1 Construction model
Workspace graph generation:
1. finds supported REXX files in the workspace
2. parses each file independently
3. aggregates file-local graph outputs
4. injects a synthetic `WORKSPACE` root
5. groups nodes by file

### 5.2 Cross-file inference
If:
- a label is unresolved in one file
- and exactly one candidate procedure exists in another file

then:
- a `calls-cross-file` edge may be added
- unresolved-label output may be reduced accordingly
- reachability is recomputed

### 5.3 Intended interpretation
The workspace graph is:
- aggregated
- incrementally inferred
- not a full semantic whole-program resolver

### 5.4 Reachability recalculation
After inferred cross-file edges are added:
- unreachable procedures are recalculated
- orphan procedures are recalculated
- fan-in metrics can change

---

## 6. Diagnostics Design

### 6.1 Native diagnostic publication
The extension uses a VS Code diagnostic collection to publish Problems-panel issues for supported REXX files.

### 6.2 Diagnostic categories
- undefined labels
- unreachable procedures
- cleanup bypass risks
- loop risks
- dead code
- line-length warnings

### 6.3 Severity model
- Error
  - undefined label
- Warning
  - unreachable procedure
  - cleanup bypass risk
  - loop risk
  - dead code
- Information
  - line-length warning

### 6.4 Refresh lifecycle
Diagnostics update on:
- open
- change
- save
- graph render/refresh

Diagnostics clear on:
- document close
- unsupported document paths

---

## 7. Session Model

### 7.1 Session types
- document session
- workspace session

### 7.2 Session responsibilities
Each session tracks:
- associated panel
- associated document URI (or null for workspace session)
- current graph data
- render timer
- render nonce
- persisted UI state key

### 7.3 Session lifecycle
- created on demand
- updated on render/refresh
- cleaned up on panel disposal

### 7.4 Cache model
The host keeps a bounded graph cache keyed by:
- document URI
- document version

Cache behavior:
- reused for export/diagnostic/render flows
- trimmed to a bounded size
- cleared for disposed document sessions

---

## 8. Webview Design

### 8.1 Rendering model
The graph UI combines:
- SVG for edges
- HTML button nodes for interaction

### 8.2 Layout model
The graph uses a layered north/south layout with:
- ordered nodes
- edge-aware layer adjustments
- absolute positioning

### 8.3 Runtime UI capabilities
- zooming
- mouse panning
- focus mode
- search
- navigation history
- grouping
- filtering
- graph mode / detailed mode switching

### 8.4 Workspace-specific UI behavior
- file-aware node metadata
- file grouping
- cross-file line reveal support
- dashed inferred cross-file edges

### 8.5 Persisted webview state
The webview sends normalized state updates back to the host for workspace-backed persistence.

---

## 9. Export Design

### 9.1 Export formats
- JSON
- DOT
- Excalidraw
- SVG
- PNG

### 9.2 Generation paths
- JSON/DOT/Excalidraw are generated in the host
- SVG is generated from the webview graph state and sent to the host
- PNG is rasterized from SVG in the webview and then sent to the host for saving

### 9.3 Save behavior
Save dialogs default to:
- source-document directory when possible
- home directory otherwise

### 9.4 Workspace export behavior
Workspace exports use a synthetic workspace export document as the save base when no concrete source file applies.

---

## 10. Security and Trust Model

### 10.1 Security posture
The extension is local-only and does not use:
- auth
- remote APIs
- cloud services
- secret storage

### 10.2 Webview protection
- strict CSP
- nonce-based scripts
- restricted local resource roots
- normalized and bounded messages

### 10.3 Message validation
Validated message families include:
- reveal line
- export JSON
- export DOT
- export Excalidraw
- export SVG
- export PNG
- persist UI state
- PNG error reporting

### 10.4 Custom CSS safety
Custom CSS is constrained by:
- extension requirement (`.css`)
- relative-path trust policy
- file-size cap
- sanitization of risky CSS constructs

### 10.5 Export safety
- payload size checks
- PNG error surfacing
- blob URL cleanup/revocation

---

## 11. Reliability Strategy

### 11.1 Error handling
The host uses centralized user-facing error reporting wrappers.

### 11.2 Safe refresh patterns
Refresh operations are guarded so failures do not silently corrupt session state.

### 11.3 Persistence normalization
Persisted UI state is normalized and bounded before storage.

### 11.4 Disposal cleanup
Session disposal clears active resources and related cache state.

---

## 12. Verification Strategy

### 12.1 Fast local verification
- `npm run lint`
- `npm run syntax-check`
- `npm run smoke`
- `npm test`

### 12.2 Real extension-host verification
- `npm run test:vscode`

### 12.3 CI verification
GitHub Actions runs:
- local verification
- extension-host harness under `xvfb`

### 12.4 Current tested areas
- parser behavior
- CSS sanitization
- message normalization
- session lifecycle
- workspace graph command behavior
- export trigger behavior
- persistence writes
- cross-file inference behavior
- extension-host harness wiring

---

## 13. Technical Limitations

1. Workspace graphing is still incremental and approximate.
2. Full semantic inter-file resolution is not implemented.
3. The extension-host harness is heavier than Node-based local tests.
4. Webview rendering remains the largest complexity surface.

---

## 14. Future Technical Work

Likely future engineering directions:
- further split `lib/webview-render.js`
- improve cross-file semantic resolution
- add richer editor-native integrations
- introduce tree/sidebar navigation architecture
- add more precise code actions around diagnostics

---

## 15. Technical Summary

The plugin architecture is organized around:
- a parser and analysis core
- a host orchestration layer
- a webview rendering layer
- native VS Code diagnostics and command integration
- strong local and CI verification

Its main current technical tradeoff is deliberate: it provides useful incremental workspace inference without attempting a full semantic whole-program model.
