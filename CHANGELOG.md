# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Semantic Versioning for published extension versions.

## [1.0.6] - 2026-06-21

### Added

- **UMLMark: Generate UML Diagram** command — right-click any `.yaml` file in the editor or file explorer to run the matching UMLGen CLI tool directly from VS Code.
  - Automatically routes to the correct CLI (`umls-gen`, `umlc-gen`, `pyc-gen`, `pys-gen`) by reading `diagram.type` and `runtime.language` from the YAML config.
  - Sends the command to the currently active terminal (preserves the user's virtual environment activation).
  - Workspace-relative path with forward slashes passed as `--config` argument — works on Windows, macOS, and Linux.
  - Registers a one-shot file system watcher on `output.path`; opens the generated `.puml` file automatically when it appears (30 s timeout).
  - Status bar notification on dispatch; information notification on success; warning notification on timeout.
  - TypeScript/JavaScript languages reserved for future `tsc-gen` / `tss-gen` support with a clear user-facing message.
  - Available in both **editor right-click menu** and **Explorer right-click menu** under the **UMLMark** command group.
  - Accessible via Command Palette as **UMLMark: Generate UML Diagram**.

### Changed

- Detailed PlantUML error messages (exception type and stack trace in text format for easy copy/report).

## [1.0.5] - 2026-05-03

### Added

- New release baseline for UMLMark branding and publication track.
- Standardized changelog format for future GitHub releases.

### Changed

- Updated extension metadata for the first UMLMark release line.
- README refresh to align with UMLMark Suite style:
  - Ecosystem section
  - Dual-license section
  - Support section
  - Developer workflow section

