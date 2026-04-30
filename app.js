var dev = null, fw = null, isDfuSe = false, isRuntimeMode = false, needsReconnectAfterDetach = false, dfuTransferSize = 0;
// USB DFU protocol values: 0x01=Runtime, 0x02=DFU mode (standard DFU or DFU-Se).
const DFU_PROTOCOL_RUNTIME = 0x01;
const DFU_PROTOCOL_DFU_MODE = 0x02;
const DFU_VERSION_DFUSE = 0x011A;
const DEFAULT_TRANSFER_SIZE = 1024; // Conservative default for maximum compatibility
const KNOWN_DFUSE_DEVICES = new Set([
    '1D50:6017' // Black Magic Probe DFU bootloader
]);
const cb = document.getElementById('c');
const tb = document.getElementById('t');
const db = document.getElementById('d');
const fi = document.getElementById('f');
const ai = document.getElementById('a');
const addrRow = document.getElementById('addr-row');
const infoBox = document.getElementById('info');
const pc = document.getElementById('p');
const pb = document.getElementById('b');
const lg = document.getElementById('l');

function log(msg, isError) {
    const div = document.createElement('div');
    div.className = isError ? 'e' : '';
    div.textContent = msg;
    lg.appendChild(div);
    lg.scrollTop = lg.scrollHeight;
    lg.style.display = 'block';
}

function formatErrorMessage(error) {
    return String(error?.message ?? error);
}

function toHex(value, width) {
    return value.toString(16).toUpperCase().padStart(width, '0');
}

function decodeDfuSePermissions(tag) {
    const c = String(tag || '').toLowerCase();
    const value = (c >= 'a' && c <= 'g') ? (c.charCodeAt(0) - 96) : 0;
    const perms = [];
    if (value & 0x01) perms.push('readable');
    if (value & 0x02) perms.push('erasable');
    if (value & 0x04) perms.push('writable');
    return perms.length ? perms.join(', ') : 'unknown';
}

function parseDfuSeMemoryMap(name) {
    if (!name || !name.startsWith('@')) {
        return null;
    }
    const firstSlash = name.indexOf('/');
    const secondSlash = (firstSlash >= 0) ? name.indexOf('/', firstSlash + 1) : -1;
    if (firstSlash < 0 || secondSlash < 0) {
        return null;
    }
    const regionName = name.slice(1, firstSlash).trim() || 'Unknown';
    const baseAddress = parseInt(name.slice(firstSlash + 1, secondSlash).trim(), 16);
    if (Number.isNaN(baseAddress)) {
        return null;
    }

    const layout = name.slice(secondSlash + 1).trim();
    const segments = layout.split(',').map(x => x.trim()).filter(Boolean);
    let cursor = baseAddress;
    const ranges = [];

    for (const segment of segments) {
        const m = segment.match(/^(\d+)\*(\d+)([BKM])([a-g])$/i);
        if (!m) {
            continue;
        }
        const count = parseInt(m[1], 10);
        const size = parseInt(m[2], 10);
        const unit = m[3].toUpperCase();
        const tag = m[4].toLowerCase();
        const multiplier = unit === 'K' ? 1024 : (unit === 'M' ? 1024 * 1024 : 1);
        const sectorSize = size * multiplier;
        const totalSize = count * sectorSize;
        const start = cursor;
        const end = cursor + totalSize - 1;
        ranges.push(`0x${toHex(start, 8)}-0x${toHex(end, 8)} (${decodeDfuSePermissions(tag)})`);
        cursor = end + 1;
    }

    return { regionName, ranges };
}

function clearDeviceInfo() {
    infoBox.textContent = '';
    infoBox.style.display = 'none';
}

function showDeviceInfo(device, selectedInterface, runtimeMode) {
    const modeLabel = runtimeMode ? 'Runtime' : 'DFU';
    const vid = toHex(device.vendorId, 4).toLowerCase();
    const pid = toHex(device.productId, 4).toLowerCase();
    const cfg = selectedInterface.configuration.configurationValue;
    const intf = selectedInterface.interface.interfaceNumber;
    const alt = selectedInterface.alternate.alternateSetting;
    const name = device.productName || selectedInterface.name || '(unnamed)';
    const mfg = device.manufacturerName || '(unknown)';
    const serial = device.serialNumber || '(unknown)';
    const infoLines = [
        `Name: ${name}`,
        `MFG: ${mfg}`,
        `Serial: ${serial}`,
        `${modeLabel}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}" ${runtimeMode ? 'runtime' : 'dfu'}`
    ];

    if (!runtimeMode) {
        const parsedMap = parseDfuSeMemoryMap(selectedInterface.name);
        if (parsedMap) {
            infoLines.push(`Selected memory region: ${parsedMap.regionName}`);
            infoLines.push(...parsedMap.ranges);
        }
    }

    infoBox.textContent = infoLines.join('\n');
    infoBox.style.display = 'block';
}

// DfuSe interfaces commonly expose memory map names like "@Internal Flash ...",
// so we use name hints instead of protocol 0x02 alone.
function hasDfuSeNameHint(name) {
    if (!name) {
        return false;
    }
    const normalized = String(name).trim();
    return normalized.startsWith('@') || /dfu[-\s]?se/i.test(normalized);
}

async function readDfuFunctionalDescriptor(intfNumber) {
    const GET_DESCRIPTOR = 0x06;
    const DT_CONFIGURATION = 0x02;
    const DT_DFU_FUNCTIONAL = 0x21;
    
    try {
        // First, read the configuration descriptor header to get total length
        const headerResult = await dev.device_.controlTransferIn({
            requestType: 'standard',
            recipient: 'device',
            request: GET_DESCRIPTOR,
            value: (DT_CONFIGURATION << 8) | 0,  // Configuration 0
            index: 0
        }, 4);
        
        if (headerResult.status !== 'ok' || headerResult.data.byteLength < 4) {
            return null;
        }
        
        // Get total length of configuration descriptor
        const wTotalLength = headerResult.data.getUint16(2, true);
        
        // Read the full configuration descriptor
        const fullResult = await dev.device_.controlTransferIn({
            requestType: 'standard',
            recipient: 'device',
            request: GET_DESCRIPTOR,
            value: (DT_CONFIGURATION << 8) | 0,
            index: 0
        }, wTotalLength);
        
        if (fullResult.status !== 'ok') {
            return null;
        }
        
        // Parse configuration descriptor to find DFU functional descriptor
        const data = new DataView(fullResult.data.buffer);
        let offset = 0;
        
        while (offset + 2 <= data.byteLength) {
            const bLength = data.getUint8(offset);
            const bDescriptorType = data.getUint8(offset + 1);
            
            if (bLength === 0) break;  // Invalid descriptor
            if (offset + bLength > data.byteLength) break;  // Out of bounds
            
            // Found DFU Functional Descriptor
            if (bDescriptorType === DT_DFU_FUNCTIONAL && bLength >= 9) {
                return {
                    transferSize: data.getUint16(offset + 5, true),
                    bcdDfuVersion: data.getUint16(offset + 7, true)
                };
            }
            
            offset += bLength;
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

async function connectDevice() {
    log('🔍 Requesting USB DFU device...');
    
    let device;
    try {
        device = await navigator.usb.requestDevice({ filters: [] });
    } catch (error) {
        throw error;
    }
    
    const interfaces = dfu.findDeviceDfuInterfaces(device);
    if (interfaces.length === 0) {
        throw new Error('No DFU interface found');
    }
    
    // Runtime is protocol 0x01. Protocol 0x02 can be standard DFU mode or DFU-Se.
    const selectedInterface = interfaces[0];
    const cfgValue = selectedInterface.configuration.configurationValue;
    const intfNumber = selectedInterface.interface.interfaceNumber;
    const altSetting = selectedInterface.alternate.alternateSetting;
    const vidHex = device.vendorId.toString(16).padStart(4, '0').toUpperCase();
    const pidHex = device.productId.toString(16).padStart(4, '0').toUpperCase();
    const nameHintDfuSe = hasDfuSeNameHint(selectedInterface.name);
    const knownVidPidDfuSe = KNOWN_DFUSE_DEVICES.has(vidHex + ':' + pidHex);
    let versionHintDfuSe = false;
    isRuntimeMode = selectedInterface.protocol === DFU_PROTOCOL_RUNTIME;
    isDfuSe = (
        !isRuntimeMode &&
        selectedInterface.protocol === DFU_PROTOCOL_DFU_MODE &&
        (nameHintDfuSe || knownVidPidDfuSe)
    );
    
    dev = new dfu.Device(device, interfaces[0]);
    await dev.open();

    // Try to read transfer size from device, fall back to conservative default if unavailable
    dfuTransferSize = DEFAULT_TRANSFER_SIZE;
    
    try {
        const functionalDescriptor = await readDfuFunctionalDescriptor(dev.intfNumber);
        if (functionalDescriptor) {
            if (functionalDescriptor.transferSize > 0 && functionalDescriptor.transferSize <= 4096) {
                dfuTransferSize = functionalDescriptor.transferSize;
                log('✅ DFU transferSize: ' + dfuTransferSize + ' bytes (from Configuration Descriptor)');
                log('🔎 DFU Version: 0x' + functionalDescriptor.bcdDfuVersion.toString(16).toUpperCase().padStart(4, '0'));
            } else {
                log('⚠️ Invalid transferSize in descriptor: ' + functionalDescriptor.transferSize + ', using default: ' + DEFAULT_TRANSFER_SIZE);
            }
            versionHintDfuSe = functionalDescriptor.bcdDfuVersion >= DFU_VERSION_DFUSE;
            isDfuSe = isDfuSe || (!isRuntimeMode && versionHintDfuSe);
        } else {
            log('⚠️ DFU Functional Descriptor not found, using default transferSize: ' + DEFAULT_TRANSFER_SIZE + ' bytes');
        }
    } catch (error) {
        log('⚠️ Failed to read DFU descriptor: ' + formatErrorMessage(error));
        log('ℹ️ Using default transferSize: ' + DEFAULT_TRANSFER_SIZE + ' bytes');
    }
    
    const vid_str = '0x' + device.vendorId.toString(16).padStart(4, '0').toUpperCase();
    const pid_str = '0x' + device.productId.toString(16).padStart(4, '0').toUpperCase();
    log('✅ Connected: VID=' + vid_str + ' PID=' + pid_str);
    log('🔎 DFU: cfg=' + cfgValue + ', intf=' + intfNumber + ', alt=' + altSetting + ', proto=0x' + selectedInterface.protocol.toString(16).toUpperCase().padStart(2, '0'));
    log('🔖 ' + (interfaces[0].name || '(unnamed)'));
    if (!isRuntimeMode) {
        log('🔎 DFU-Se hints: name=' + (nameHintDfuSe ? 'yes' : 'no') + ', version=' + (versionHintDfuSe ? 'yes' : 'no') + ', known-vidpid=' + (knownVidPidDfuSe ? 'yes' : 'no'));
    }
    if (isRuntimeMode) {
        log('📋 Protocol: DFU Runtime');
        log('ℹ️ Device is in runtime mode. Click "Detach" then reconnect to start download.');
    } else {
        log('📋 Protocol: ' + (isDfuSe ? 'DFU-Se (extended)' : 'DFU 1.1 (standard)'));
    }
    showDeviceInfo(device, selectedInterface, isRuntimeMode);
    
    // Show address bar only for DFU-Se devices
    addrRow.style.display = (!isRuntimeMode && isDfuSe) ? 'flex' : 'none';
    
    return device;
}

cb.addEventListener('click', async () => {
    try {
        await connectDevice();
        
        if (isRuntimeMode) {
            cb.textContent = '⚠️ Connected - Click Detach';
            cb.disabled = true;
            tb.style.display = 'block';
            tb.disabled = false;
            db.disabled = true;
        } else {
            cb.textContent = '✅ Connected';
            cb.disabled = true;
            tb.style.display = 'none';
            tb.disabled = true;
            db.disabled = (fw === null);
            if (needsReconnectAfterDetach) {
                needsReconnectAfterDetach = false;
                log('✅ Reconnected in DFU mode, ready to download.');
            }
        }
    } catch (error) {
        clearDeviceInfo();
        log('❌ Connection failed: ' + formatErrorMessage(error), true);
    }
});

tb.addEventListener('click', async () => {
    if (!dev) {
        return void log('❌ Device not connected. Please connect first.', true);
    }
    
    try {
        tb.disabled = true;
        log('🔀 Sending DFU DETACH...');
        await dev.detach();
        log('✅ DETACH sent. Please reconnect the device in DFU mode.');
        needsReconnectAfterDetach = true;
        
        try {
            await dev.close();
        } catch (error) {
            log('⚠️ Close warning: ' + formatErrorMessage(error));
        }
        
        dev = null;
        isRuntimeMode = false;
        isDfuSe = false;
        clearDeviceInfo();
        addrRow.style.display = 'none';
        db.disabled = true;
        tb.style.display = 'none';
        cb.textContent = '🔌 Reconnect to Device';
        cb.disabled = false;
    } catch (error) {
        log('❌ Detach failed: ' + formatErrorMessage(error), true);
        tb.disabled = false;
    }
});

fi.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
        log('🔄 Loading firmware file: ' + file.name + '...');
        const reader = new FileReader();
        reader.onload = (e) => {
            fw = e.target.result;
            if (fw && fw.byteLength > 0) {
                log('✅ Loaded: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + 'KB, ' + fw.byteLength + ' bytes)');
                db.disabled = (dev === null || isRuntimeMode || needsReconnectAfterDetach);
            } else {
                log('❌ Failed to load firmware file', true);
                fw = null;
                db.disabled = true;
            }
        };
        reader.onerror = () => {
            log('❌ Error reading firmware file', true);
            fw = null;
            db.disabled = true;
        };
        reader.readAsArrayBuffer(file);
    } else {
        // File input was cleared
        fw = null;
        db.disabled = true;
        log('⚠️ Firmware file cleared');
    }
});

db.addEventListener('click', async () => {
    if (!dev || !fw) {
        return void log('⚠️ Please connect device and select firmware', true);
    }
    
    // Verify firmware data is valid
    if (!fw.byteLength || fw.byteLength === 0) {
        return void log('❌ Firmware data is empty. Please select a valid firmware file.', true);
    }
    
    if (isRuntimeMode) {
        return void log('⚠️ Device is in DFU runtime mode. Click "Detach" first, then reconnect before downloading.', true);
    }
    if (needsReconnectAfterDetach) {
        return void log('⚠️ Please reconnect the device in DFU mode before downloading.', true);
    }
    
    if (!dev.device_.opened) {
        return void log('❌ Device not connected properly. Please reconnect.', true);
    }
    
    let targetAddress = null;
    if (isDfuSe) {
        targetAddress = 0x08002000;
        const addrStr = ai.value.trim();
        if (addrStr) {
            try {
                targetAddress = parseInt(addrStr, addrStr.startsWith('0x') ? 16 : 10);
                if (isNaN(targetAddress) || targetAddress < 0) {
                    throw new Error('Invalid address');
                }
            } catch (error) {
                return void log('❌ Invalid target address: ' + addrStr, true);
            }
        }
    }
    
    try {
        db.disabled = true;
        pc.style.display = 'block';
        pb.textContent = 'Preparing...';
        log('⚡ Starting firmware download...');
        if (isDfuSe) {
            log('📍 Target: 0x' + targetAddress.toString(16).toUpperCase());
        }
        log('🔄 Preparing device...');
        
        let deviceReady = false;
        try {
            await dev.abortToIdle();
            log('✅ Device reset to IDLE state');
            deviceReady = true;
        } catch (err) {
            log('⚠️ Device reset failed: ' + err);
            // Try to recover by clearing status
            try {
                log('🔄 Attempting to clear device status...');
                await dev.clearStatus();
                await new Promise(resolve => setTimeout(resolve, 100));
                const state = await dev.getState();
                if (state === 2) { // dfuIDLE
                    log('✅ Device recovered to IDLE state');
                    deviceReady = true;
                } else {
                    log('❌ Device state: ' + state + ' (not IDLE)');
                    throw new Error('Device not in IDLE state, please reconnect');
                }
            } catch (recoverErr) {
                log('❌ Recovery failed: ' + recoverErr, true);
                db.disabled = false;
                pc.style.display = 'none';
                return;
            }
        }
        
        if (!deviceReady) {
            log('❌ Device not ready for download', true);
            db.disabled = false;
            pc.style.display = 'none';
            return;
        }
        
        // Wait for device to stabilize after abort
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Verify device is in correct DFU state before downloading
        try {
            const state = await dev.getState();
            const stateNames = {
                0: 'APP_IDLE', 1: 'APP_DETACH', 2: 'DFU_IDLE', 3: 'DFU_DNLOAD_SYNC',
                4: 'DFU_DNBUSY', 5: 'DFU_DNLOAD_IDLE', 6: 'DFU_MANIFEST_SYNC',
                7: 'DFU_MANIFEST', 8: 'DFU_MANIFEST_WAIT_RESET', 9: 'DFU_UPLOAD_IDLE',
                10: 'DFU_ERROR'
            };
            const stateName = stateNames[state] || 'UNKNOWN';
            log('🔎 Device state: ' + state + ' (' + stateName + ')');
            
            // Only DFU_IDLE (2) is acceptable for starting a new download
            if (state !== 2) {
                log('⚠️ Device state is ' + stateName + ', not DFU_IDLE. Attempting recovery...');
                
                // Force clear any pending operations
                try {
                    await dev.clearStatus();
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (e) {
                    log('⚠️ Clear status: ' + e);
                }
                
                try {
                    await dev.abort();
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (e) {
                    log('⚠️ Abort: ' + e);
                }
                
                // Verify recovery
                const newState = await dev.getState();
                log('🔎 After recovery: ' + newState + ' (' + (stateNames[newState] || 'UNKNOWN') + ')');
                
                if (newState !== 2) {
                    throw new Error('Device stuck in state ' + (stateNames[newState] || newState) + '. Please disconnect and reconnect the device.');
                }
                log('✅ Device recovered to DFU_IDLE');
            } else {
                log('✅ Device ready for download');
            }
        } catch (err) {
            log('❌ State check failed: ' + err, true);
            db.disabled = false;
            pc.style.display = 'none';
            return;
        }
        
        dev.logInfo = msg => log(msg);
        dev.logError = msg => log(msg, true);
        dev.logWarning = msg => log(msg);
        // dev.logDebug = msg => log('🐛 ' + msg);  // Uncomment for debugging
        dev.logDebug = msg => {};  // Disabled for cleaner output
        dev.logProgress = (done, total) => {
            if (total) {
                const pct = Math.round(done / total * 100);
                pb.textContent = '📝 Writing ' + pct + '%';
                pb.style.width = pct + '%';
            }
        };
        
        let transferSize = dfuTransferSize;
        
        // Validate transfer size
        if (!transferSize || transferSize <= 0) {
            log('⚠️ Invalid transfer size detected, using default: ' + DEFAULT_TRANSFER_SIZE);
            transferSize = DEFAULT_TRANSFER_SIZE;
        }
        
        log('📦 Transfer size: ' + transferSize + ' bytes');
        log('📦 Firmware size: ' + fw.byteLength + ' bytes');
        
        let downloadCompleted = false;
        
        try {
            // Enable manifestationTolerant to wait for firmware installation
            await dev.do_download(transferSize, fw, true, targetAddress);
            downloadCompleted = true;
            log('✅ Firmware downloaded successfully!');
            log('🔄 Device is resetting...');
            pb.style.width = '100%';
            pb.textContent = '✅ Complete';
        } catch (innerError) {
            const err = innerError.toString();
            
            // Check if this is a manifestation-phase error (data transfer already completed)
            const isManifestError = err.includes('DFU manifest') || err.includes('Manifesting');
            const isDisconnectError = err.includes('NetworkError') || 
                                     err.includes('transfer error') ||
                                     err.includes('Device unavailable') || 
                                     err.includes('disconnected');
            
            // If data transfer completed and device disconnected during manifest, that's success
            if (isManifestError && isDisconnectError) {
                log('✅ Firmware downloaded successfully!');
                log('🔄 Device has reset (normal behavior)');
                pb.style.width = '100%';
                pb.textContent = '✅ Complete';
                downloadCompleted = true;
            } else if (downloadCompleted) {
                // Download was marked complete but still got an error
                log('✅ Download complete! Device has reset (normal behavior)');
                pb.style.width = '100%';
                pb.textContent = '✅ Complete';
            } else {
                // Real error during data transfer
                throw innerError;
            }
        }
    } catch (error) {
        log('❌ Download failed: ' + error, true);
        log('💡 Try disconnecting and reconnecting the device', true);
        db.disabled = false;
    }
});

if (navigator.usb) {
    log('✅ WebUSB ready');
    log('ℹ️ Supports standard DFU 1.1 and DFU-Se devices');
    log('ℹ️ Click "Connect" to start');
    
    // Clear any cached file selection on page load
    // This ensures fw variable matches the file input state
    if (fi.files.length === 0) {
        fw = null;
        db.disabled = true;
    }
} else {
    log('❌ WebUSB not supported', true);
    cb.disabled = true;
}

// Theme Switcher
(function() {
    const themeButtons = document.querySelectorAll('.theme-btn');
    const htmlElement = document.documentElement;
    
    // Load saved theme or default to light
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    
    function setTheme(themeName) {
        htmlElement.setAttribute('data-theme', themeName);
        localStorage.setItem('theme', themeName);
        
        // Update active button
        themeButtons.forEach(btn => {
            if (btn.dataset.theme === themeName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    
    // Add click handlers to theme buttons
    themeButtons.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            setTheme(this.dataset.theme);
        });
    });
})();
