# Changelog

## [0.3.0]

### Added
- Serial monitor input — send lines to the device directly from the panel
- Currently running file shown in the panel while code is executing
- File tree view — device files and folders shown as collapsible tree (expanded by default)
- Folder support — recursive listing, recursive delete with confirmation dialog
- Folder structure preserved when uploading a folder from PC (subdirectories created on device automatically)
- Inline Open / Run / Del buttons per file row (visible on hover)
- Open File from Board and Delete Selected buttons work on tree selection
- Automatic retry (5 attempts) on all mpremote operations before alerting user

### Changed
- Save to device (Ctrl+S / Cmd+S) rewritten to be more robust — all mpremote operations now go through a single queue, shared upload logic between panel and save command
- Serial monitor is stopped and pending mpremote operations aborted before firmware flashing, so the port is always free

### Fixed
- Serial port left busy when saving a file to the device — active serial connections now released before upload
- Flash address now detected from firmware filename on every flash path (0x0 for ESP32-C2/C3/C6/S3, 0x1000 for ESP32/S2) — previously ESP32-C6 flashing from web failed
- File list refreshed too early after flashing (board not yet booted)
- Open file from device failed for files inside subdirectories
- Sync `fs.lstatSync` / `fs.readdirSync` calls replaced with async equivalents
- GitHub API requests in module handler had no timeout (could hang indefinitely)
- Response stream not consumed when probing module deep path (socket leak)
- Module fetch unnecessarily re-fetched categories when valid cache existed

## [0.2.0]

### Added
- Serial monitor toggle (start/stop from panel)
- Module browser with category support, including flat-structure categories (e.g. Qwiic)
- GitHub authentication for higher API rate limits when fetching modules
- 24-hour module cache with refresh button and "last updated" timestamp
- Auto-select module when only one result in category
- Flash progress bar with percentage during ESP32 firmware write
- UF2 firmware support for RP2040/RP2350 boards
- Firmware list fetched from micropython.org (ESP32, RP2040, RP2350)
- Delete All Files button
- Open file from device into editor

### Fixed
- Serial port locked during firmware flash (monitor now stopped before flashing)
- mpremote process not killed on stop (now kills entire process group)
- Wrong flash address for ESP32-C6/C3/C2/S3 (0x0 instead of 0x1000)
- esptool deprecated flag warnings
- Module category dropdown blank after module search
- execCommand error messages now include stderr output

## [0.1.0]

### Added
- Initial release
- ESP32 firmware flashing via esptool
- MicroPython file manager (list, upload, delete, run)
- Serial monitor
- Save Python file to device on Ctrl+S / Cmd+S
