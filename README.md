
# Soldered MicroPython Helper

⚠️ **Experimental Extension**  
Use at your own risk. This extension is actively being developed.

A MicroPython-focused helper for working with ESP-based boards directly inside Visual Studio Code.

## 🔧 Features

- Flash firmware to boards
- Upload and delete `.py` files
- Live serial output monitoring (Thonny-style)
- Fetch libraries and examples from Soldered's GitHub
- Fully powered by `mpremote` and `esptool.py`

## Required Installations and Setup

1. **Node.js and npm**
   - Needed to run and package VSCode extensions.
   - Download: https://nodejs.org/

2. **Visual Studio Code**
   - Obviously needed to run the extension.
   - Download: https://code.visualstudio.com/

3. **Python 3.x**
   - Required to run esptool and mpremote commands.
   - Download: https://www.python.org/downloads/

4. **Python packages:**
   Install these packages globally or in a virtual environment accessible to your system PATH.

   ```bash
   pip install esptool mpremote
   ```

5. **Serial Port Support:**
   - The extension uses the `serialport` npm package to list serial devices.
   - This requires native build tools on your system.

   For Windows:
   ```bash
   npm install --global --production windows-build-tools
   ```
   Or follow instructions for windows-build-tools here:
   https://github.com/felixrieseberg/windows-build-tools

   For macOS:
   - Install Xcode Command Line Tools:
   ```bash
   xcode-select --install
   ```

   For Linux:
   - Make sure you have build-essential and Python development headers installed.
   ```bash
   sudo apt-get install build-essential python3-dev
   ```

6. **Install serialport npm package in your extension folder**
   ```bash
   npm install serialport
   ```

7. **Make sure your Python executable and scripts (`esptool` and `mpremote`) are in your PATH environment variable** 
   so the extension can invoke them via `exec`.

8. **Permission to access serial ports:**
   - On Linux/macOS you may need to add your user to the `dialout` or `uucp` group or use `sudo` for accessing serial ports.
   - On Windows, running VSCode as administrator can help with serial port access.

## Summary of commands to run

```bash
# Install Python packages
pip install esptool mpremote

# Install serialport npm package
npm install serialport

# For running the ext
npm run vscode:prepublish 

# To use open the src/extension.ts and run (f5) 
```

After this setup, your VSCode extension should be able to use serial ports and run `esptool` and `mpremote` commands as intended.
