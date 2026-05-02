var dev = null, fw = null, isDfuSe = false, isRuntimeMode = false, needsReconnectAfterDetach = false, dfuTransferSize = 0, dfuSeDefaultAddress = null, dfuSeMemorySegments = [];
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
const fwSourceTabs = Array.from(document.querySelectorAll('.fw-source-tab'));
const fwRow = document.getElementById('fw-row');
const uploadRow = document.getElementById('upload-row');
const fwList = document.getElementById('fw-list');
const fwToggle = document.getElementById('fw-toggle');
const fi = document.getElementById('f');
const ai = document.getElementById('a');
const addrRow = document.getElementById('addr-row');
const infoBox = document.getElementById('info');
const eraseWrap = document.getElementById('p-erase');
const eraseBar = document.getElementById('pe');
const eraseFill = document.getElementById('be');
const writeWrap = document.getElementById('p-write');
const pc = document.getElementById('p');
const pb = document.getElementById('b');
const lg = document.getElementById('l');
let fwManifest = [];
let fwManifestWarningShown = false;
let firmwareSourceMode = 'fw-list';
let selectedFwPath = '';
let fwListExpanded = false;

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
    const bits = getDfuSePermissionBits(tag);
    const perms = [];
    if (bits & 0x01) perms.push('readable');
    if (bits & 0x02) perms.push('erasable');
    if (bits & 0x04) perms.push('writable');
    return perms.length ? perms.join(', ') : 'unknown';
}

function getDfuSePermissionBits(tag) {
    const c = String(tag || '').toLowerCase();
    return (c >= 'a' && c <= 'g') ? (c.charCodeAt(0) - 96) : 0;
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
    const parsedSegments = [];
    let firstWritableStart = null;

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
        const permissionBits = getDfuSePermissionBits(tag);

        ranges.push(`0x${toHex(start, 8)}-0x${toHex(end, 8)} (${decodeDfuSePermissions(tag)})`);

        parsedSegments.push({
            start,
            end: end + 1,
            sectorSize,
            readable: (permissionBits & 0x01) !== 0,
            erasable: (permissionBits & 0x02) !== 0,
            writable: (permissionBits & 0x04) !== 0
        });

        if (firstWritableStart === null && (permissionBits & 0x04)) {
            firstWritableStart = start;
        }

        cursor = end + 1;
    }

    return { regionName, ranges, segments: parsedSegments, firstWritableStart };
}

function getFirmwareVectorInfo(buffer) {
    if (!buffer || buffer.byteLength < 8) {
        return null;
    }

    const view = new DataView(buffer);
    const stackPointer = view.getUint32(0, true);
    const resetHandler = view.getUint32(4, true);
    return { stackPointer, resetHandler };
}

function isLikelyArmStackPointer(value) {
    // Typical Cortex-M SRAM region: 0x2000_0000 - 0x3FFF_FFFF.
    return value >= 0x20000000 && value <= 0x3FFFFFFF;
}

function isAddressInsideImage(address, imageBase, imageSize) {
    return address >= imageBase && address < (imageBase + imageSize);
}

function clearDeviceInfo() {
    infoBox.textContent = '';
    infoBox.style.display = 'none';
}

function updateDownloadButtonState() {
    db.disabled = (dev === null || isRuntimeMode || needsReconnectAfterDetach || fw === null);
}

function clearLoadedFirmware() {
    fw = null;
    updateDownloadButtonState();
}

function normalizeFwPath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function buildResourceUrl(path) {
    return new URL(normalizeFwPath(path), window.location.href);
}

async function loadFirmwareFromFwList() {
    const selected = selectedFwPath;
    if (!selected) {
        log('⚠️ Please select a firmware from fw list.');
        return;
    }

    const filePath = normalizeFwPath(selected);
    if (!filePath.startsWith('fw/')) {
        log('❌ Invalid fw path in manifest: ' + filePath, true);
        return;
    }

    log('🔄 Loading firmware from fw list: ' + filePath + '...');

    try {
        const fwUrl = buildResourceUrl(filePath);
        fwUrl.searchParams.set('v', Date.now().toString());
        const response = await fetch(fwUrl.toString(), { cache: 'no-store' });
        if (!response.ok) {
            throw new Error('HTTP ' + response.status + ' while fetching ' + filePath);
        }

        const buffer = await response.arrayBuffer();
        if (!buffer || buffer.byteLength === 0) {
            throw new Error('Firmware file is empty');
        }

        fw = buffer;
        selectedFwPath = filePath;
        renderFwList();
        log('✅ Loaded from fw list: ' + filePath + ' (' + (buffer.byteLength / 1024).toFixed(1) + 'KB, ' + buffer.byteLength + ' bytes)');
        updateDownloadButtonState();
    } catch (error) {
        clearLoadedFirmware();
        log('❌ Failed to load fw list firmware: ' + formatErrorMessage(error), true);
    }
}

function renderFwList() {
    while (fwList.firstChild) {
        fwList.removeChild(fwList.firstChild);
    }

    if (!Array.isArray(fwManifest) || fwManifest.length === 0) {
        const none = document.createElement('div');
        none.className = 'fw-empty';
        none.textContent = 'No firmware found in fw/manifest.json';
        fwList.appendChild(none);
        fwToggle.style.display = 'none';
        return;
    }

    const visibleCount = fwListExpanded ? fwManifest.length : Math.min(4, fwManifest.length);
    for (let i = 0; i < visibleCount; i++) {
        const entry = fwManifest[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fw-item';
        const isActive = entry.path === selectedFwPath;
        if (isActive) {
            btn.classList.add('active');
        }

        if (isActive) {
            const badge = document.createElement('span');
            badge.className = 'fw-item-badge';
            badge.textContent = 'Selected';
            btn.appendChild(badge);
        }

        const main = document.createElement('span');
        main.className = 'fw-item-main';
        const displayName = entry.label || entry.name || entry.path;
        main.textContent = displayName;

        const meta = document.createElement('span');
        meta.className = 'fw-item-meta';
        const shortPath = normalizeFwPath(entry.path).replace(/^fw\//i, '');
        meta.textContent = shortPath;

        // Browser-native tooltip shows full name/path when text is truncated.
        btn.title = `${displayName}\n${normalizeFwPath(entry.path)}`;

        btn.appendChild(main);
        btn.appendChild(meta);
        btn.addEventListener('click', async () => {
            selectedFwPath = entry.path;
            clearLoadedFirmware();
            renderFwList();
            await loadFirmwareFromFwList();
        });
        fwList.appendChild(btn);
    }

    if (fwManifest.length > 4) {
        fwToggle.style.display = 'block';
        fwToggle.textContent = fwListExpanded ? 'Collapse' : `Show ${fwManifest.length - 4} more`;
    } else {
        fwToggle.style.display = 'none';
    }
}

async function loadFwManifest(showErrors) {
    if (window.location.protocol === 'file:') {
        fwManifest = [];
        renderFwList();
        if (showErrors && !fwManifestWarningShown) {
            log('⚠️ Current page is opened via file://. Browser security blocks manifest loading. Please run a local web server and open via http://localhost/...', true);
            fwManifestWarningShown = true;
        }
        return;
    }

    try {
        const manifestUrl = buildResourceUrl('fw/manifest.json');
        manifestUrl.searchParams.set('v', Date.now().toString());
        const response = await fetch(manifestUrl.toString(), { cache: 'no-store' });
        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }

        const payload = await response.json();
        const files = Array.isArray(payload.files) ? payload.files : [];
        fwManifest = files
            .map(item => {
                if (typeof item === 'string') {
                    const name = item.split('/').pop();
                    return { path: normalizeFwPath(item), name, label: name };
                }

                const path = normalizeFwPath(item.path || '');
                const name = item.name || path.split('/').pop();
                const label = item.label || name;
                return { path, name, label };
            })
            .filter(item => item.path.startsWith('fw/') && item.path.toLowerCase().endsWith('.bin'));

        if (fwManifest.length > 0 && !selectedFwPath) {
            selectedFwPath = fwManifest[0].path;
            clearLoadedFirmware();
            await loadFirmwareFromFwList();
        } else {
            renderFwList();
        }
        log('✅ Loaded fw firmware list (' + fwManifest.length + ' item' + (fwManifest.length === 1 ? '' : 's') + ').');
        fwManifestWarningShown = false;
    } catch (error) {
        fwManifest = [];
        selectedFwPath = '';
        renderFwList();
        if (showErrors && !fwManifestWarningShown) {
            log('⚠️ Could not load fw/manifest.json (' + formatErrorMessage(error) + '). Check server path and that fw/manifest.json is publicly accessible.', true);
            fwManifestWarningShown = true;
        }
    }
}

function setFirmwareSourceMode(mode) {
    firmwareSourceMode = mode;
    fwSourceTabs.forEach(tab => {
        if (tab.dataset.source === mode) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    updateFirmwareSourceUI();
}

function updateFirmwareSourceUI() {
    const useFwList = firmwareSourceMode === 'fw-list';
    uploadRow.style.display = useFwList ? 'none' : 'flex';
    fwRow.style.display = useFwList ? 'flex' : 'none';

    clearLoadedFirmware();
    if (!useFwList) {
        selectedFwPath = '';
        fwListExpanded = false;
        renderFwList();
    }
}

function resetProgressBars() {
    if (eraseFill) {
        eraseFill.style.width = '0%';
        eraseFill.textContent = '0%';
    }
    if (pb) {
        pb.style.width = '0%';
        pb.textContent = '0%';
    }
}

function setProgressVisibility(showErase) {
    if (eraseWrap) {
        eraseWrap.style.display = showErase ? 'block' : 'none';
    }
    if (writeWrap) {
        writeWrap.style.display = 'block';
    }
}

function updatePhaseProgress(phase, done, total) {
    if (!total || total <= 0) {
        return;
    }

    const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)));

    if (phase === 'erase' && eraseFill) {
        eraseFill.style.width = pct + '%';
        eraseFill.textContent = pct + '%';
        return;
    }

    if (pb) {
        pb.style.width = pct + '%';
        pb.textContent = pct + '%';
    }
}

async function setReadyToReconnectState(message) {
    if (dev && dev.device_ && dev.device_.opened) {
        try {
            await dev.close();
        } catch (error) {
            log('⚠️ Close warning: ' + formatErrorMessage(error));
        }
    }

    dev = null;
    isRuntimeMode = false;
    isDfuSe = false;
    dfuSeDefaultAddress = null;
    dfuSeMemorySegments = [];
    needsReconnectAfterDetach = false;

    clearDeviceInfo();
    addrRow.style.display = 'none';
    tb.style.display = 'none';
    tb.disabled = true;
    db.disabled = true;
    cb.textContent = '🔌 Reconnect to Device';
    cb.disabled = false;

    if (message) {
        log(message);
    }
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

async function readInterfaceStringDescriptor(device, stringIndex, langID) {
    const GET_DESCRIPTOR = 0x06;
    const DT_STRING = 0x03;

    if (!stringIndex || stringIndex <= 0) {
        return null;
    }

    const request = {
        requestType: 'standard',
        recipient: 'device',
        request: GET_DESCRIPTOR,
        value: (DT_STRING << 8) | stringIndex,
        index: langID
    };

    const header = await device.controlTransferIn(request, 2);
    if (header.status !== 'ok' || header.data.byteLength < 2) {
        return null;
    }

    const totalLength = header.data.getUint8(0);
    if (totalLength < 2) {
        return null;
    }

    const full = await device.controlTransferIn(request, totalLength);
    if (full.status !== 'ok' || full.data.byteLength < 2) {
        return null;
    }

    const out = [];
    for (let i = 2; i + 1 < full.data.byteLength; i += 2) {
        out.push(full.data.getUint16(i, true));
    }
    return String.fromCharCode.apply(String, out);
}

async function readInterfaceNameFallback(usbDevice, configValue, intfNumber, altSetting) {
    const GET_DESCRIPTOR = 0x06;
    const DT_CONFIGURATION = 0x02;
    const DT_INTERFACE = 0x04;

    try {
        const header = await usbDevice.controlTransferIn({
            requestType: 'standard',
            recipient: 'device',
            request: GET_DESCRIPTOR,
            value: (DT_CONFIGURATION << 8) | 0,
            index: 0
        }, 4);

        if (header.status !== 'ok' || header.data.byteLength < 4) {
            return null;
        }

        const totalLength = header.data.getUint16(2, true);
        const full = await usbDevice.controlTransferIn({
            requestType: 'standard',
            recipient: 'device',
            request: GET_DESCRIPTOR,
            value: (DT_CONFIGURATION << 8) | 0,
            index: 0
        }, totalLength);

        if (full.status !== 'ok' || full.data.byteLength < 9) {
            return null;
        }

        const data = new DataView(full.data.buffer);
        if (data.getUint8(5) !== configValue) {
            return null;
        }

        let offset = 9;
        while (offset + 2 <= data.byteLength) {
            const bLength = data.getUint8(offset);
            const bDescriptorType = data.getUint8(offset + 1);
            if (bLength === 0 || offset + bLength > data.byteLength) {
                break;
            }

            if (bDescriptorType === DT_INTERFACE && bLength >= 9) {
                const dIntf = data.getUint8(offset + 2);
                const dAlt = data.getUint8(offset + 3);
                const iInterface = data.getUint8(offset + 8);
                if (dIntf === intfNumber && dAlt === altSetting && iInterface > 0) {
                    const name = await readInterfaceStringDescriptor(usbDevice, iInterface, 0x0409);
                    return name || null;
                }
            }

            offset += bLength;
        }
    } catch (error) {
        return null;
    }

    return null;
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

    if (!selectedInterface.name) {
        const recoveredName = await readInterfaceNameFallback(
            dev.device_,
            cfgValue,
            intfNumber,
            altSetting
        );
        if (recoveredName) {
            selectedInterface.name = recoveredName;
            log('🔎 Recovered interface name from string descriptor: ' + recoveredName);
        }
    }

    const parsedMap = parseDfuSeMemoryMap(selectedInterface.name);
    dfuSeMemorySegments = parsedMap && Array.isArray(parsedMap.segments) ? parsedMap.segments : [];
    dfuSeDefaultAddress = parsedMap && parsedMap.firstWritableStart !== null ? parsedMap.firstWritableStart : null;

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

    const hasDfuSeMemoryMap = !!(parsedMap && Array.isArray(parsedMap.segments) && parsedMap.segments.length > 0);

    if (isDfuSe && hasDfuSeMemoryMap && typeof dfuse !== 'undefined' && typeof dfuse.Device === 'function') {
        const openedUsbDevice = dev.device_;
        dev = new dfuse.Device(openedUsbDevice, interfaces[0]);
    } else if (isDfuSe && !hasDfuSeMemoryMap) {
        log('⚠️ DFU-Se memory map not available from interface descriptor. Falling back to generic DFU-Se flow with manual target address.');
    }
    
    const vid_str = '0x' + device.vendorId.toString(16).padStart(4, '0').toUpperCase();
    const pid_str = '0x' + device.productId.toString(16).padStart(4, '0').toUpperCase();
    log('✅ Connected: VID=' + vid_str + ' PID=' + pid_str);
    log('🔎 DFU: cfg=' + cfgValue + ', intf=' + intfNumber + ', alt=' + altSetting + ', proto=0x' + selectedInterface.protocol.toString(16).toUpperCase().padStart(2, '0'));
    log('🔖 ' + (interfaces[0].name || '(unnamed)'));
    if (!isRuntimeMode) {
        log('🔎 DFU-Se hints: name=' + (nameHintDfuSe ? 'yes' : 'no') + ', version=' + (versionHintDfuSe ? 'yes' : 'no') + ', known-vidpid=' + (knownVidPidDfuSe ? 'yes' : 'no'));
        if (isDfuSe && dfuSeDefaultAddress !== null) {
            log('📍 Default target from memory map: 0x' + dfuSeDefaultAddress.toString(16).toUpperCase());
        }
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
    if (!isRuntimeMode && isDfuSe && dfuSeDefaultAddress !== null && !ai.value.trim()) {
        ai.value = '0x' + dfuSeDefaultAddress.toString(16).toUpperCase();
    }
    
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
            updateDownloadButtonState();
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
        dfuSeDefaultAddress = null;
        dfuSeMemorySegments = [];
        clearDeviceInfo();
        addrRow.style.display = 'none';
        updateDownloadButtonState();
        tb.style.display = 'none';
        cb.textContent = '🔌 Reconnect to Device';
        cb.disabled = false;
    } catch (error) {
        log('❌ Detach failed: ' + formatErrorMessage(error), true);
        tb.disabled = false;
    }
});

fi.addEventListener('change', (event) => {
    if (firmwareSourceMode !== 'upload') {
        return;
    }

    const file = event.target.files[0];
    if (file) {
        if (file.name.toLowerCase().endsWith('.dfu')) {
            clearLoadedFirmware();
            fi.value = '';
            log('❌ .dfu container files are not supported in this page. Please use a raw .bin firmware.', true);
            return;
        }

        log('🔄 Loading firmware file: ' + file.name + '...');
        const reader = new FileReader();
        reader.onload = (e) => {
            fw = e.target.result;
            if (fw && fw.byteLength > 0) {
                log('✅ Loaded: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + 'KB, ' + fw.byteLength + ' bytes)');
                updateDownloadButtonState();
            } else {
                log('❌ Failed to load firmware file', true);
                clearLoadedFirmware();
            }
        };
        reader.onerror = () => {
            log('❌ Error reading firmware file', true);
            clearLoadedFirmware();
        };
        reader.readAsArrayBuffer(file);
    } else {
        // File input was cleared
        clearLoadedFirmware();
        log('⚠️ Firmware file cleared');
    }
});

fwSourceTabs.forEach(tab => {
    tab.addEventListener('click', async () => {
        const nextMode = tab.dataset.source;
        if (!nextMode || nextMode === firmwareSourceMode) {
            return;
        }

        setFirmwareSourceMode(nextMode);
        if (firmwareSourceMode === 'fw-list') {
            await loadFwManifest(true);
            if (selectedFwPath && fw === null) {
                await loadFirmwareFromFwList();
            }
        }
    });
});

fwToggle.addEventListener('click', () => {
    if (!Array.isArray(fwManifest) || fwManifest.length <= 3) {
        return;
    }
    fwListExpanded = !fwListExpanded;
    renderFwList();
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
        targetAddress = (dfuSeDefaultAddress !== null) ? dfuSeDefaultAddress : 0x08002000;
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

        const vectors = getFirmwareVectorInfo(fw);
        if (vectors) {
            const resetAddress = vectors.resetHandler & 0xFFFFFFFE;
            const stackOk = isLikelyArmStackPointer(vectors.stackPointer);
            const resetInImage = isAddressInsideImage(resetAddress, targetAddress, fw.byteLength);

            if (!stackOk) {
                return void log('❌ Firmware vector table looks invalid (initial SP not in SRAM). Confirm this is a Cortex-M .bin image.', true);
            }

            if (!resetInImage) {
                return void log('❌ Reset vector 0x' + resetAddress.toString(16).toUpperCase() + ' is outside target image range [0x' + targetAddress.toString(16).toUpperCase() + ', 0x' + (targetAddress + fw.byteLength - 1).toString(16).toUpperCase() + ']. Target address is likely wrong.', true);
            }
        }
    }
    
    try {
        db.disabled = true;
        resetProgressBars();
        setProgressVisibility(isDfuSe);
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
                updateDownloadButtonState();
                pc.style.display = 'none';
                return;
            }
        }
        
        if (!deviceReady) {
            log('❌ Device not ready for download', true);
            updateDownloadButtonState();
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
        
        let progressPhase = isDfuSe ? 'erase' : 'write';
        dev.logInfo = msg => {
            log(msg);
            const normalized = String(msg).toLowerCase();
            if (normalized.includes('eras')) {
                progressPhase = 'erase';
            }
            if (normalized.includes('copying data from browser to dfu device') ||
                normalized.includes('starting dfu-se data transfer') ||
                normalized.includes('starting data transfer')) {
                progressPhase = 'write';
            }
            if (normalized.includes('manifest')) {
                progressPhase = 'manifest';
            }
        };
        dev.logError = msg => log(msg, true);
        dev.logWarning = msg => log(msg);
        // dev.logDebug = msg => log('🐛 ' + msg);  // Uncomment for debugging
        dev.logDebug = msg => {};  // Disabled for cleaner output
        dev.logProgress = (done, total) => {
            updatePhaseProgress(progressPhase, done, total);
        };
        
        let transferSize = dfuTransferSize;
        
        // Validate transfer size
        if (!transferSize || transferSize <= 0) {
            log('⚠️ Invalid transfer size detected, using default: ' + DEFAULT_TRANSFER_SIZE);
            transferSize = DEFAULT_TRANSFER_SIZE;
        }
        
        log('📦 Transfer size: ' + transferSize + ' bytes');
        log('📦 Firmware size: ' + fw.byteLength + ' bytes');

        if (isDfuSe && typeof dev.startAddress !== 'undefined' && targetAddress !== null) {
            dev.startAddress = targetAddress;
        }
        
        let downloadCompleted = false;
        
        try {
            // Enable manifestationTolerant to wait for firmware installation
            const canUseNativeDfuSe = (
                isDfuSe &&
                typeof dfuse !== 'undefined' &&
                (dev instanceof dfuse.Device) &&
                dev.memoryInfo &&
                Array.isArray(dev.memoryInfo.segments) &&
                dev.memoryInfo.segments.length > 0
            );

            if (canUseNativeDfuSe) {
                await dev.do_download(transferSize, fw, true);
            } else {
                await dev.do_download(transferSize, fw, true, targetAddress, isDfuSe ? dfuSeMemorySegments : null);
            }
            downloadCompleted = true;
            log('✅ Firmware downloaded successfully!');
            log('🔄 Device is resetting...');
            updatePhaseProgress('write', 100, 100);
            if (isDfuSe) {
                updatePhaseProgress('erase', 100, 100);
            }
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
                updatePhaseProgress('write', 100, 100);
                if (isDfuSe) {
                    updatePhaseProgress('erase', 100, 100);
                }
                downloadCompleted = true;
            } else if (downloadCompleted) {
                // Download was marked complete but still got an error
                log('✅ Download complete! Device has reset (normal behavior)');
                updatePhaseProgress('write', 100, 100);
                if (isDfuSe) {
                    updatePhaseProgress('erase', 100, 100);
                }
            } else {
                // Real error during data transfer
                throw innerError;
            }
        }

        if (downloadCompleted) {
            await setReadyToReconnectState('✅ Ready for next flash. Reconnect device to download again.');
        }
    } catch (error) {
        log('❌ Download failed: ' + error, true);
        log('💡 Try disconnecting and reconnecting the device', true);
        updateDownloadButtonState();
    }
});

if (navigator.usb) {
    navigator.usb.addEventListener('disconnect', async (event) => {
        if (dev && dev.device_ && event.device === dev.device_) {
            await setReadyToReconnectState('🔌 Device disconnected. Ready to reconnect.');
        }
    });

    log('✅ WebUSB ready');
    log('ℹ️ Supports standard DFU 1.1 and DFU-Se devices');
    log('ℹ️ Click "Connect" to start');
    
    // Clear any cached file selection on page load
    // This ensures fw variable matches the file input state
    if (fi.files.length === 0) {
        clearLoadedFirmware();
    }

    setFirmwareSourceMode('fw-list');
    loadFwManifest(false);
} else {
    log('❌ WebUSB not supported', true);
    cb.disabled = true;
}

// Theme Switcher
(function() {
    const themeButtons = document.querySelectorAll('.theme-btn');
    const themeSwitcher = document.getElementById('theme-switcher');
    const htmlElement = document.documentElement;
    let scrollFadeTimer = null;
    
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

    window.addEventListener('scroll', () => {
        if (!themeSwitcher) {
            return;
        }

        themeSwitcher.classList.add('scrolling');
        if (scrollFadeTimer !== null) {
            clearTimeout(scrollFadeTimer);
        }

        scrollFadeTimer = setTimeout(() => {
            themeSwitcher.classList.remove('scrolling');
            scrollFadeTimer = null;
        }, 180);
    }, { passive: true });
})();
