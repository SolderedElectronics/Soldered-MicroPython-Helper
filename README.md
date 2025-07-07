# Soldered MicroPython Helper

⚠️ **Experimental Extension**  
Use at your own risk. This extension is actively being developed.

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=SolderedElectronics.soldered-micropython-helper&ssr=false)

A MicroPython-focused helper for working with ESP-based boards directly inside Visual Studio Code.  
Flash firmware, upload scripts, monitor serial output, and fetch Soldered libraries — all in one place.

---

## 🚀 Quick Setup (Required for Extension to Work)

Run the following commands in your terminal:

```bash
# Install required Python tools
pip install esptool mpremote

# Install serialport Node.js package
npm install serialport
```

Make sure:
- Your Python executables (`esptool` and `mpremote`) are in your system `PATH`
- You have permission to access serial ports (see below)

---

## 🔍 How to Find and Install in VS Code

1. Open **Visual Studio Code**
2. Go to the **Extensions** tab (or press `Ctrl+Shift+X`)
3. Search for: `Soldered MicroPython Helper`
4. Click **Install**

Or [install it directly from the VS Code Marketplace →](https://marketplace.visualstudio.com/items?itemName=SolderedElectronics.soldered-micropython-helper&ssr=false)

---

## 🔧 Features

- Flash firmware to boards (via `esptool.py`)
- Upload and delete `.py` files (via `mpremote`)
- Live serial output monitoring
- Fetch libraries and examples from Soldered's GitHub
- Auto-detect serial ports and show device files

---

## ⚙️ Full Setup Instructions

### Requirements

1. **Node.js and npm** — [Download](https://nodejs.org/)
2. **Python 3.x** — [Download](https://www.python.org/downloads/)
3. **Visual Studio Code** — [Download](https://code.visualstudio.com/)

### Python packages (required globally or in your active environment):

```bash
pip install esptool mpremote
```

### Serial Port Support

To use the `serialport` Node.js library, native build tools must be installed:

- **Windows:**
  ```bash
  npm install --global --production windows-build-tools
  ```

- **macOS:**
  ```bash
  xcode-select --install
  ```

- **Linux:**
  ```bash
  sudo apt-get install build-essential python3-dev
  ```

Then, install `serialport`:

```bash
npm install serialport
```

---

## 🛠 Other Notes

- On Linux/macOS, you may need to add your user to the `dialout` or `uucp` group:
  ```bash
  sudo usermod -a -G dialout $USER
  ```
  Then log out and back in.

- On Windows, try running VS Code as Administrator if ports don’t show up.

---

After completing the above, your VS Code extension should be able to access serial ports and run `esptool` and `mpremote` commands correctly.

---

## About Soldered

Soldered Electronics is a European-based company designing and manufacturing **open-source hardware** for makers, hobbyists, educators, and professionals.

We specialize in:
- Electronic boards, sensors, and actuators
- Projects in microelectronics, robotics, mechatronics, and IoT
- Supporting users with [📚 tutorials, code, and schematics](https://soldered.com/documentation/)

---

## At a Glance

- 🇭🇷 Based in Osijek, Croatia  
- 🛠️ 200+ in-house designed products  
- 🚚 225,000+ units delivered to 80+ countries  
- 🌍 Open-source, high-quality, and community-driven  
- ⭐ 4.8 average review score on TrustPilot
- 💬 [24/7 technical support](https://soldered.com/contact/)

---

## Have fun!

Thank you for your support from your fellow makers at Soldered Electronics.

Happy Making!