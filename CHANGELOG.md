# [0.10.0](https://github.com/tmonk/stata-workbench/compare/v0.9.1...v0.10.0) (2025-12-28)


### Features

* Add runFileBehavior configuration and enhance runFile functionality ([0952d36](https://github.com/tmonk/stata-workbench/commit/0952d360377eb4bee4b3cba69216ef9ca4edb48d))
* Add runFileBehavior configuration and enhance runFile functionality ([f1331f6](https://github.com/tmonk/stata-workbench/commit/f1331f6c1db13ca2fbf6b60d9bfe33f198634673))

# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.2] - 2025-12-22

### Changed

* **Windsurf / Windsurf Next:** Updated MCP config paths and support.

## [0.8.1] - 2025-12-22

### Changed

* Documentation updates.

## [0.8.0] - 2025-12-22

### Added

* **Data Browser:** Explore datasets with a live, in-editor table view.

## [0.7.3] - 2025-12-22

### Fixed

* Prevented logs from emitting full base64 payloads.

## [0.7.2] - 2025-12-21

### Fixed

* MCP config handling: avoid duplicate entries across host formats; preserve custom env/settings.

## [0.7.1] - 2025-12-21

### Changed

* Hardened `mcp.json` editing and preserved custom config values more reliably.

## [0.7.0] - 2025-12-21

### Added

* UI improvements (including codicons integration).

## [0.6.0] - 2025-12-19

### Added

* **Full do-file streaming** with live output.
* Improved scrolling behavior.
* Artifact modal for better file viewing.

### Removed

* `stataMcp.enableStreaming` configuration (streaming now always enabled).

## [0.5.0] - 2025-12-19

### Added

* **Streaming output** for real-time command execution feedback.

## [0.4.4] - 2025-12-17

### Changed

* Updated compatibility for `mcp-stata` 0.4.0.

## [0.4.3] - 2025-12-16

### Changed

* Minor improvements and bug fixes.

## [0.4.2] - 2025-12-15

### Added

* Windows platform support improvements.

### Changed

* Updates to `mcp_stata` integration.

## [0.4.1] - 2025-12-15

### Changed

* Project renaming updates.

## [0.4.0] - 2025-12-14

### Added

* Command history navigation (PageUp/PageDown).
* Tab completion for variable names.

## [0.3.2] - 2025-12-14

### Added

* Automatic MCP package refresh functionality.

## [0.3.1] - 2025-12-14

### Changed

* Updated README with packaging instructions.
* Documentation/test updates.

## [0.3.0] - 2025-12-14

### Added

* **Terminal panel** with context header for the last command executed.
* Artifact utilities for improved file handling.
* Test commands in README.

### Changed

* Refactored terminal panel functionality and UI polish.

### Removed

* Deprecated run panel.

## [0.2.3] - 2025-12-14

### Fixed

* Icon visibility in VS Code Marketplace.

### Changed

* Updated VSIX build instructions and automated `package-lock.json` updates in CI.

## [0.2.2] - 2025-12-14

### Added

* Documentation icon and refreshed tests/docs.

### Changed

* Revised installation section and badge/documentation links.

## [0.2.1] - 2025-12-14

### Added

* Extension icon, deeplinks, and documentation updates.

### Changed

* Refactored env var names for MCP command consistency; updated `package.json` metadata.

## [0.2.0] - 2025-12-14

### Added

* **Custom working directory** setting for `.do` files.
* CONTRIBUTING guidelines.

### Changed

* Updated README and `package.json` for the new configuration.

## [0.1.1] - 2025-12-13

### Added

* **Syntax highlighting** for Stata code.

### Changed

* Documentation and packaging workflow improvements.

## [0.1.0] - 2025-12-13

### Added

* Initial release of **Stata Workbench**.
* Publishing support for Open VSX + VS Code Marketplace.
* GitHub Actions workflow for VSIX packaging on release.

[Unreleased]: https://github.com/tmonk/stata-workbench/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/tmonk/stata-workbench/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/tmonk/stata-workbench/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/tmonk/stata-workbench/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/tmonk/stata-workbench/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/tmonk/stata-workbench/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/tmonk/stata-workbench/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/tmonk/stata-workbench/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/tmonk/stata-workbench/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tmonk/stata-workbench/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/tmonk/stata-workbench/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/tmonk/stata-workbench/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/tmonk/stata-workbench/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/tmonk/stata-workbench/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/tmonk/stata-workbench/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/tmonk/stata-workbench/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/tmonk/stata-workbench/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/tmonk/stata-workbench/compare/v.0.2.3...v0.3.0
[0.2.3]: https://github.com/tmonk/stata-workbench/compare/v0.2.2...v.0.2.3
[0.2.2]: https://github.com/tmonk/stata-workbench/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/tmonk/stata-workbench/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tmonk/stata-workbench/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/tmonk/stata-workbench/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tmonk/stata-workbench/releases/tag/v0.1.0
[1]: https://github.com/tmonk/stata-workbench/tags
