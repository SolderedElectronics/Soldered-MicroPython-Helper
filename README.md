# Soldered MicroPython Helper

A MicroPython-focused extension for Visual Studio Code designed for working with ESP and RP2-based boards. Flash firmware, upload scripts, monitor serial output, and fetch Soldered libraries — all from within the editor.

> **Note:** This extension is actively developed. Report issues on [GitHub](https://github.com/SolderedElectronics/Soldered-MicroPython-Helper/issues).

[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=SolderedElectronics.soldered-micropython-helper)

---

## Requirements

Before using this extension, install the required Python tools:

```bash
pip install esptool mpremote
```

Both `esptool` and `mpremote` must be accessible on your system `PATH`.

### Serial port access

**Linux:** If your board does not appear in the port list, run this once to grant your account access to serial ports:

```bash
sudo usermod -a -G dialout $USER
```

Then **log out and log back in**. After that, the extension can communicate with your board.

**macOS:** No extra steps needed. If your board does not appear in the port list, you may need to install a USB-Serial driver for your board's chip:

- [CP210x driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers) — used by most ESP32 boards
- [CH340 driver](https://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html) — used by some cheaper boards

After installing the driver, replug your board.

**Windows:** If no ports appear, try running VS Code as Administrator.

---

## Features

- Flash MicroPython firmware to ESP and RP2-based boards
- Upload, run, and delete `.py` files on the device
- Upload entire folders preserving directory structure
- Browse files and folders on the device in a tree view
- Live serial output monitoring
- Open and edit files directly from the device
- Fetch Soldered libraries and examples from GitHub
- Auto-detect connected serial ports

---

## Installation

1. Open Visual Studio Code.
2. Go to the Extensions panel (`Ctrl+Shift+X`).
3. Search for `Soldered MicroPython Helper`.
4. Click **Install**.

Alternatively, [install directly from the Marketplace](https://marketplace.visualstudio.com/items?itemName=SolderedElectronics.soldered-micropython-helper).

---

## Usage

### Selecting a port

<!-- IMAGE: port selection dropdown screenshot -->

Select your board's serial port from the COM Port dropdown. Buttons requiring a connected device are disabled until a port is selected.

### Flashing firmware

<!-- IMAGE: firmware flash section screenshot -->

Select your board from the grouped dropdown and click **Flash**. The extension fetches the latest official MicroPython firmware automatically.

### Uploading files

<!-- IMAGE: upload section screenshot -->

Upload the currently open file, any `.py` file from your PC, or an entire folder. When uploading a folder, the directory structure is preserved on the device — subdirectories are created automatically. Files can be run directly on the device and stopped at any time.

### Managing files on the device

<!-- IMAGE: file list screenshot -->

Click **List Files** to browse files and folders on the device in a tree view. Folders are expanded by default and can be collapsed. Hover over any item to reveal inline **Open**, **Run**, and **Del** buttons. Files opened from the device are downloaded to a temporary location and opened in the editor. Deleting a folder removes it and all its contents after confirmation.

### Installing Soldered modules

<!-- IMAGE: module section screenshot -->

Browse modules by category and select a module from the dropdown. Install the library, examples, or both with a single click.

### Serial monitor

<!-- IMAGE: serial monitor output screenshot -->

Open the serial monitor to stream device output to the VS Code output panel. The monitor closes automatically when uploading or running files.

---

## Notes on MicroPython code

Always include a delay inside `while True` loops. Without one, the device may become unresponsive and output becomes unreadable.

```python
from time import sleep

while True:
    sleep(0.5)
    print("Running...")
```

---

## Planned / TODO

- **Drag & drop file upload** — drag `.py` files from your OS file explorer directly into the file tree to upload them to the device
- **Create folder on device** — add a new folder directly from the panel without uploading a file first
- **Port rescanning on disconnect** — automatically restart port scanning when a board is unplugged
- **Extension settings menu**
---

## Developer Setup

### Prerequisites

- [Node.js](https://nodejs.org/) and `npm`
- [Python 3.x](https://www.python.org/)
- Native build tools for the `serialport` package:
  - **Windows:** `npm install --global --production windows-build-tools`
  - **macOS:** `xcode-select --install`
  - **Linux:** `sudo apt-get install build-essential python3-dev`

### Build

```bash
npm install
npm run vscode:prepublish
```

### Run locally

Open the project in VS Code and press `F5` to launch an Extension Development Host with the extension loaded.

---

## About Soldered

<img src="https://raw.githubusercontent.com/e-radionicacom/Soldered-Generic-Arduino-Library/dev/extras/Soldered-logo-color.png" alt="soldered-logo" width="500"/>

At Soldered, we design and manufacture a wide selection of electronic products to help you turn your ideas into acts and bring you one step closer to your final project. Our products are intended for makers and crafted in-house by our experienced team in Osijek, Croatia. We believe that sharing is a crucial element for improvement and innovation, and we work hard to stay connected with all our makers regardless of their skill or experience level. Therefore, all our products are open-source. Finally, we always have your back. If you face any problem concerning either your shopping experience or your electronics project, our team will help you deal with it, offering efficient customer service and cost-free technical support anytime. Some of those might be useful for you:

- [Web Store](https://www.soldered.com/shop)
- [Tutorials & Projects](https://soldered.com/learn)
- [Community & Technical support](https://soldered.com/community)

### Open-source license

Soldered invests vast amounts of time into hardware & software for these products, which are all open-source. Please support future development by buying one of our products.

Check license details in the LICENSE file. Long story short, use these open-source files for any purpose you want to, as long as you apply the same open-source licence to it and disclose the original source. No warranty — all designs in this repository are distributed in the hope that they will be useful, but without any warranty. They are provided "AS IS", therefore without warranty of any kind, either expressed or implied. The entire quality and performance of what you do with the contents of this repository are your responsibility. In no event, Soldered (TAVU) will be liable for your damages, losses, including any general, special, incidental or consequential damage arising out of the use or inability to use the contents of this repository.

## Have fun!

And thank you from your fellow makers at Soldered Electronics.
