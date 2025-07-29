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

1. **Python 3.x** — [Download](https://www.python.org/downloads/)
2. **Visual Studio Code** — [Download](https://code.visualstudio.com/)

---

## ⚠️ Warning: Avoid Infinite Loops Without Delay

When writing MicroPython code — especially when using `while True` loops — it's **critical to include a `sleep()` or other delay inside the loop**. This is standard practice to avoid common issues such as:

- **CPU overload** — the loop runs thousands of times per second without pause
- **Unreadable output** — serial prints become too fast to read
- **Poor device responsiveness** — the device may become unresponsive or glitchy
- **Unnecessary power consumption**

### ✅ Recommended pattern:

```python
from time import sleep

while True:
    sleep(0.5)  # Add delay between iterations
    print("Doing something...")
```

Here's a real-world example from APDS9960 gesture detection:

```python
while True:
    sleep(0.5)
    if apds.isGestureAvailable():
        motion = apds.readGesture()
        print("Gesture={}".format(dirs.get(motion, "unknown")))
```

🧠 **Tip**: You can adjust the delay based on sensor type or application needs — just make sure *some* delay is present in every infinite loop.

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

## 🧪 For Developers

If you'd like to contribute or modify this extension locally, follow these steps:

### 1. Install dependencies
Make sure you have [Node.js](https://nodejs.org/), `npm`, and [Python 3.x](https://www.python.org/) installed.

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

Python packages (required globally or in your active environment):

```bash
npm install
pip install esptool mpremote
```

### 2. Build the extension
```bash
npm run vscode:prepublish
```

### 3. Launch in VS Code

- Open the project folder in VS Code.
- Press `F5` to open a new Extension Development Host window.
- The extension will load there and can be tested as if it were installed.

---

## About Soldered

<img src="https://raw.githubusercontent.com/e-radionicacom/Soldered-Generic-Arduino-Library/dev/extras/Soldered-logo-color.png" alt="soldered-logo" width="500"/>

At Soldered, we design and manufacture a wide selection of electronic products to help you turn your ideas into acts and bring you one step closer to your final project. Our products are intented for makers and crafted in-house by our experienced team in Osijek, Croatia. We believe that sharing is a crucial element for improvement and innovation, and we work hard to stay connected with all our makers regardless of their skill or experience level. Therefore, all our products are open-source. Finally, we always have your back. If you face any problem concerning either your shopping experience or your electronics project, our team will help you deal with it, offering efficient customer service and cost-free technical support anytime. Some of those might be useful for you:

- [Web Store](https://www.soldered.com/shop)
- [Tutorials & Projects](https://soldered.com/learn)
- [Community & Technical support](https://soldered.com/community)

### Open-source license

Soldered invests vast amounts of time into hardware & software for these products, which are all open-source. Please support future development by buying one of our products.

Check license details in the LICENSE file. Long story short, use these open-source files for any purpose you want to, as long as you apply the same open-source licence to it and disclose the original source. No warranty - all designs in this repository are distributed in the hope that they will be useful, but without any warranty. They are provided "AS IS", therefore without warranty of any kind, either expressed or implied. The entire quality and performance of what you do with the contents of this repository are your responsibility. In no event, Soldered (TAVU) will be liable for your damages, losses, including any general, special, incidental or consequential damage arising out of the use or inability to use the contents of this repository.

## Have fun!

And thank you from your fellow makers at Soldered Electronics.
