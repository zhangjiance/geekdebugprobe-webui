# GeekDebugProbe WebUI

WebUSB-based DFU Firmware Update Tool

## Introduction

A web-based DFU (Device Firmware Update) tool that allows firmware flashing directly from your browser without installing drivers or applications.

## Features

- ⚡ **Zero Installation** - Pure web application, no software installation needed
- 🔌 **WebUSB Support** - Direct device communication using browser WebUSB API
- 📦 **Multi-Protocol** - Supports both standard DFU and DFU-Se protocols
- 🎨 **Theme Support** - Light and dark mode available
- 📍 **Address Configuration** - Custom target address support for DFU-Se
- 🔄 **Auto Detection** - Smart device type and protocol detection

## Usage

1. **Connect Device** - Click "Connect to Device" and select your USB device
2. **Select Firmware** - Choose a `.bin` or `.dfu` firmware file
3. **Set Address** - (Optional) Configure target address for DFU-Se devices
4. **Download** - Click "Download Firmware" to start the update

## Browser Requirements

Requires a modern browser with WebUSB API support:
- Chrome/Edge 61+
- Opera 48+

## Supported Devices

- Black Magic Probe (DFU Bootloader)
- Other DFU/DFU-Se compliant USB devices

## File Structure

- `index.html` - Main page
- `app.js` - Application logic and UI control
- `dfu.js` - DFU protocol implementation
- `styles.css` - Interface styles

## License

See LICENSE file

## Notes

- Ensure stable device connection during firmware update
- Backup important data before updating
