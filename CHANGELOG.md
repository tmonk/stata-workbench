## [0.14.3](https://github.com/tmonk/stata-workbench/compare/v0.14.2...v0.14.3) (2026-01-20)


### Bug Fixes

* update organisation ([a9d1ba6](https://github.com/tmonk/stata-workbench/commit/a9d1ba652fff685fc86674d13ff7b4bd5967f261))

## [0.14.2](https://github.com/tmonk/stata-workbench/compare/v0.14.1...v0.14.2) (2026-01-20)


### Bug Fixes

* update Sentry release handling to use environment variable ([c9127b0](https://github.com/tmonk/stata-workbench/commit/c9127b0981a675a38aa0d885064b28696657fc98))

## [0.14.1](https://github.com/tmonk/stata-workbench/compare/v0.14.0...v0.14.1) (2026-01-20)


### Bug Fixes

* update Sentry integration ([0c94da9](https://github.com/tmonk/stata-workbench/commit/0c94da92b756b699dc050915c082c465f909b6c6))

# [0.14.0](https://github.com/tmonk/stata-workbench/compare/v0.13.6...v0.14.0) (2026-01-20)


### Bug Fixes

* added bun.lock ([ef05f4a](https://github.com/tmonk/stata-workbench/commit/ef05f4ac7f24ebf975fe2e09e3e25ba0a1024466))
* enhance Sentry integration for Bun compatibility and improve test mocks ([4aefb71](https://github.com/tmonk/stata-workbench/commit/4aefb716ef39a7cbd639db7c7980ed2c489278d2))


### Features

* integrate Sentry for error tracking and profiling ([f2d8392](https://github.com/tmonk/stata-workbench/commit/f2d83926c4ff45089d10ba41bea34175e70694f9))

## [0.13.6](https://github.com/tmonk/stata-workbench/compare/v0.13.5...v0.13.6) (2026-01-20)


### Bug Fixes

* gate stdout on success ([ea205ef](https://github.com/tmonk/stata-workbench/commit/ea205efb857f2cbfdd71e061b3aa74f2742f7111))
* implement dynamic versioning for mcp-stata with PyPI integration and add tests ([643a45e](https://github.com/tmonk/stata-workbench/commit/643a45e5f91a5113c6c4ac7e4aa115479846f131))

## [0.13.5](https://github.com/tmonk/stata-workbench/compare/v0.13.4...v0.13.5) (2026-01-20)


### Bug Fixes

* implement auto-refresh for missing required tools in McpClient ([06d2d8b](https://github.com/tmonk/stata-workbench/commit/06d2d8bf9d80437f05124d6132a43011e1196c4f))

## [0.13.4](https://github.com/tmonk/stata-workbench/compare/v0.13.3...v0.13.4) (2026-01-20)


### Bug Fixes

* ensure full log is loaded after run ([455ebe4](https://github.com/tmonk/stata-workbench/commit/455ebe4227278cf09880f516b2372792d63b638b))

## [0.13.3](https://github.com/tmonk/stata-workbench/compare/v0.13.2...v0.13.3) (2026-01-20)


### Bug Fixes

* add Jest configuration and ensure integration tests pass ([ecef93b](https://github.com/tmonk/stata-workbench/commit/ecef93b825b4534358c044d7ad6f7e2425a63f01))
* update MCP package management commands to use --refresh-package instead of --reinstall-package ([3675b8a](https://github.com/tmonk/stata-workbench/commit/3675b8aa0af8788d4f3a86ed445ea7acfdfb84a2))

## [0.13.2](https://github.com/tmonk/stata-workbench/compare/v0.13.1...v0.13.2) (2026-01-20)


### Bug Fixes

* update README, re-release latest version. ([698ae9f](https://github.com/tmonk/stata-workbench/commit/698ae9f115ed677bb1620c6063aa4406e464a4c8))

## [0.13.1](https://github.com/tmonk/stata-workbench/compare/v0.13.0...v0.13.1) (2026-01-20)


### Bug Fixes

* Update MCP package management commands to include --reinstall-package option to try and ensure latest version is obtained. ([3b5fec6](https://github.com/tmonk/stata-workbench/commit/3b5fec6276ec7f636f6222cab3420944459c871e))

# [0.13.0](https://github.com/tmonk/stata-workbench/compare/v0.12.1...v0.13.0) (2026-01-19)


### Features

* add showAllLogsInOutput configuration to stream raw mcp-stata logs to Output channel ([799de61](https://github.com/tmonk/stata-workbench/commit/799de61f1df4a6daceb2f442f20702d1538869d5))
* Enhance SMCL processing and HTML conversion ([b2e97a9](https://github.com/tmonk/stata-workbench/commit/b2e97a95010778aff252c23d1b2d58b8af00a127))
* Enhance task completion notifications and logging in terminal panel ([810d21e](https://github.com/tmonk/stata-workbench/commit/810d21e74e700af2fac2a560f6eab81fbdf43716))
* ensure log tailing completes before retrieving task results ([dba8205](https://github.com/tmonk/stata-workbench/commit/dba820545311dc6b61f050cc9f69dfc131137197))
* implement real-time graph streaming with deferred artifact collection ([993bfce](https://github.com/tmonk/stata-workbench/commit/993bfce16c7f5dc420281444c9242b1a2d06d663))
* migrate to background task execution model with async result retrieval ([72fb568](https://github.com/tmonk/stata-workbench/commit/72fb568c99abfea4fe87bc5633e22546cd74ed19))
* optimize log streaming by reducing polling intervals and enforcing exclusive log file mode ([cd4a27f](https://github.com/tmonk/stata-workbench/commit/cd4a27f6a1432cb1f48c5eb5a04b83f2ff677a81))
* Refactor log filtering patterns for improved whitespace tolerance and consistency ([e4a4131](https://github.com/tmonk/stata-workbench/commit/e4a4131c334e36ed5b009b4fb05b7f927129d3e1))
* remove base64 graph export option and related code for improved efficiency ([c24f75b](https://github.com/tmonk/stata-workbench/commit/c24f75b89831bfea0676e58eed58f5c2138bfebd))
* update test command to suppress experimental warnings and enhance graph data validation ([84af1ee](https://github.com/tmonk/stata-workbench/commit/84af1ee62d17b9d276596c228e5799036b42f6df))

## [0.12.1](https://github.com/tmonk/stata-workbench/compare/v0.12.0...v0.12.1) (2026-01-06)


### Bug Fixes

* enhance stderr handling and error reporting in MCP client ([3a76568](https://github.com/tmonk/stata-workbench/commit/3a76568fae1b0e544b136f80e6c17a329425f1ed))

# [0.12.0](https://github.com/tmonk/stata-workbench/compare/v0.11.0...v0.12.0) (2026-01-02)


### Features

* implement centralized log filtering and enhance log handling in MCP client and terminal panel ([3d4bb35](https://github.com/tmonk/stata-workbench/commit/3d4bb35a63946d2a3dda2e0e9cbe72c6f46400c6))

# [0.11.0](https://github.com/tmonk/stata-workbench/compare/v0.10.0...v0.11.0) (2025-12-28)


### Features

* add search functionality to terminal panel ([960f8ff](https://github.com/tmonk/stata-workbench/commit/960f8ffaffdb822393a1f205e5d76b4668604208))

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
