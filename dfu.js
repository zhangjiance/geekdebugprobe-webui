var dfu = {};
!function() {
    'use strict';
    
    dfu.DETACH = 0;
    dfu.DNLOAD = 1;
    dfu.UPLOAD = 2;
    dfu.GETSTATUS = 3;
    dfu.CLRSTATUS = 4;
    dfu.GETSTATE = 5;
    dfu.ABORT = 6;
    
    dfu.appIDLE = 0;
    dfu.appDETACH = 1;
    dfu.dfuIDLE = 2;
    dfu.dfuDNLOAD_SYNC = 3;
    dfu.dfuDNBUSY = 4;
    dfu.dfuDNLOAD_IDLE = 5;
    dfu.dfuMANIFEST_SYNC = 6;
    dfu.dfuMANIFEST = 7;
    dfu.dfuMANIFEST_WAIT_RESET = 8;
    dfu.dfuUPLOAD_IDLE = 9;
    dfu.dfuERROR = 10;
    
    dfu.STATUS_OK = 0;
    
    dfu.Device = function(device, settings) {
        this.device_ = device;
        this.settings = settings;
        this.intfNumber = settings.interface.interfaceNumber;
    };
    
    dfu.findDeviceDfuInterfaces = function(device) {
        let interfaces = [];
        for (let conf of device.configurations) {
            for (let intf of conf.interfaces) {
                for (let alt of intf.alternates) {
                    if (alt.interfaceClass == 0xFE &&
                        alt.interfaceSubclass == 0x01 &&
                        (alt.interfaceProtocol == 0x01 || alt.interfaceProtocol == 0x02)) {
                        interfaces.push({
                            configuration: conf,
                            interface: intf,
                            alternate: alt,
                            name: alt.interfaceName,
                            protocol: alt.interfaceProtocol
                        });
                    }
                }
            }
        }
        return interfaces;
    };
    
    dfu.Device.prototype.logDebug = function(msg) {};
    dfu.Device.prototype.logInfo = function(msg) { console.log(msg); };
    dfu.Device.prototype.logWarning = function(msg) { console.log(msg); };
    dfu.Device.prototype.logError = function(msg) { console.log(msg); };
    dfu.Device.prototype.logProgress = function(done, total) {};
    
    dfu.Device.prototype.open = async function() {
        await this.device_.open();
        const confValue = this.settings.configuration.configurationValue;
        if (this.device_.configuration === null ||
            this.device_.configuration.configurationValue != confValue) {
            await this.device_.selectConfiguration(confValue);
        }
        
        const intfNumber = this.settings.interface.interfaceNumber;
        if (!this.device_.configuration.interfaces[intfNumber].claimed) {
            await this.device_.claimInterface(intfNumber);
        }
        
        const altSetting = this.settings.alternate.alternateSetting;
        let intf = this.device_.configuration.interfaces[intfNumber];
        if (intf.alternate === null ||
            intf.alternate.alternateSetting != altSetting ||
            intf.alternates.length > 1) {
            try {
                await this.device_.selectAlternateInterface(intfNumber, altSetting);
            } catch (error) {
                if (intf.alternate.alternateSetting != altSetting ||
                    !error.endsWith("Unable to set device interface.")) {
                    throw error;
                }
                this.logWarning("Redundant SET_INTERFACE request failed");
            }
        }
    };
    
    dfu.Device.prototype.close = async function() {
        try {
            await this.device_.close();
        } catch (error) {
            console.log(error);
        }
    };
    
    dfu.Device.prototype.requestOut = function(bRequest, data, wValue = 0) {
        const dataLen = data ? data.byteLength || data.length || 0 : 0;
        this.logDebug("→ requestOut: req=" + bRequest + ", wValue=" + wValue + ", dataLen=" + dataLen);
        return this.device_.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: bRequest,
            value: wValue,
            index: this.intfNumber
        }, data).then(
            result => {
                this.logDebug("← requestOut result: status=" + result.status + ", written=" + result.bytesWritten);
                return (result.status == 'ok') ? Promise.resolve(result.bytesWritten) : Promise.reject(result.status);
            },
            error => {
                this.logDebug("← requestOut error: " + error);
                return Promise.reject("ControlTransferOut failed: " + error);
            }
        );
    };
    
    dfu.Device.prototype.requestIn = function(bRequest, length, wValue = 0) {
        return this.device_.controlTransferIn({
            requestType: 'class',
            recipient: 'interface',
            request: bRequest,
            value: wValue,
            index: this.intfNumber
        }, length).then(
            result => (result.status == 'ok') ? Promise.resolve(result.data) : Promise.reject(result.status),
            error => Promise.reject("ControlTransferIn failed: " + error)
        );
    };
    
    dfu.Device.prototype.download = function(data, blockNum) {
        return this.requestOut(dfu.DNLOAD, data, blockNum);
    };
    
    dfu.Device.prototype.detach = function() {
        return this.requestOut(dfu.DETACH, undefined, 1000);
    };
    
    dfu.Device.prototype.clearStatus = function() {
        return this.requestOut(dfu.CLRSTATUS);
    };
    
    dfu.Device.prototype.getStatus = function() {
        return this.requestIn(dfu.GETSTATUS, 6).then(
            data => Promise.resolve({
                status: data.getUint8(0),
                pollTimeout: data.getUint32(1, true) & 0xFFFFFF,
                state: data.getUint8(4)
            }),
            error => Promise.reject("DFU GETSTATUS failed: " + error)
        );
    };
    
    dfu.Device.prototype.getState = function() {
        return this.requestIn(dfu.GETSTATE, 1).then(
            data => Promise.resolve(data.getUint8(0)),
            error => Promise.reject("DFU GETSTATE failed: " + error)
        );
    };
    
    dfu.Device.prototype.abort = function() {
        return this.requestOut(dfu.ABORT);
    };
    
    dfu.Device.prototype.abortToIdle = async function() {
        let state = await this.getState();
        
        // If device is in MANIFEST_WAIT_RESET or other post-download states,
        // clear status first to recover
        if (state == dfu.dfuMANIFEST_WAIT_RESET || state == dfu.dfuMANIFEST) {
            this.logInfo("Device in manifestation state (" + state + "), clearing status...");
            try {
                await this.clearStatus();
                state = await this.getState();
            } catch (error) {
                this.logWarning("Clear status failed (device may have reset): " + error);
                // Device might have already reset, this is acceptable
                return;
            }
        }
        
        // Attempt abort if not in IDLE
        if (state != dfu.dfuIDLE) {
            await this.abort();
            state = await this.getState();
        }
        
        // Clear error state if present
        if (state == dfu.dfuERROR) {
            await this.clearStatus();
            state = await this.getState();
        }
        
        // Final verification
        if (state != dfu.dfuIDLE) {
            throw "Failed to return to idle state after abort: state " + state;
        }
    };
    
    dfu.Device.prototype.poll_until = async function(statePredicate) {
        let status = await this.getStatus();
        
        function sleep(ms) {
            return new Promise(function(resolve, reject) {
                setTimeout(resolve, ms);
            });
        }
        
        while (!statePredicate(status.state) && status.state != dfu.dfuERROR) {
            await sleep(status.pollTimeout);
            status = await this.getStatus();
        }
        
        return status;
    };
    
    dfu.Device.prototype.poll_until_idle = function(idle_state) {
        return this.poll_until(state => state == idle_state);
    };

    function findDfuSeSegment(segments, addr) {
        if (!Array.isArray(segments)) {
            return null;
        }

        for (const segment of segments) {
            if (segment.start <= addr && addr < segment.end) {
                return segment;
            }
        }

        return null;
    }

    function getDfuSeSectorStart(segment, addr) {
        if (!segment || !segment.sectorSize || segment.sectorSize <= 0) {
            return null;
        }

        const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
        return segment.start + (sectorIndex * segment.sectorSize);
    }
    
    dfu.Device.prototype.do_download = async function(xfer_size, data, manifestationTolerant, targetAddress, memorySegments) {
        let bytes_sent = 0;
        let expected_size = data.byteLength;
        let transaction = 0;
        const dfuSeCommandBlock = 0;
        
        this.logInfo("Downloading firmware" + (targetAddress !== null ? " using DFU-Se protocol" : " using standard DFU protocol"));
        this.logDebug("📊 Data size: " + expected_size + " bytes, Transfer size: " + xfer_size + " bytes");
        
        // Validate data
        if (!data || expected_size === 0) {
            throw "Invalid firmware data: size is " + expected_size + " bytes";
        }
        
        this.logProgress(0, expected_size);
        
        // Verify device is still ready before starting transfer.
        try {
            const preTransferState = await this.getState();
            this.logDebug("Pre-transfer device state: " + preTransferState);
            if (preTransferState !== dfu.dfuDNLOAD_IDLE && preTransferState !== dfu.dfuIDLE) {
                this.logWarning("Device not in expected state for data transfer, state=" + preTransferState);
            }
        } catch (error) {
            this.logWarning("Could not verify pre-transfer state: " + error);
        }

        if (targetAddress !== null) {
            this.logInfo("Using DFU-Se protocol blocks: command=0, data=2 with per-chunk address updates");

            if (Array.isArray(memorySegments) && memorySegments.length > 0) {
                const eraseStart = targetAddress;
                const eraseEnd = targetAddress + expected_size;
                const erasedSectors = new Set();

                this.logInfo("Erasing DFU-Se sectors for target range...");
                let eraseCursor = eraseStart;

                while (eraseCursor < eraseEnd) {
                    const segment = findDfuSeSegment(memorySegments, eraseCursor);
                    if (!segment) {
                        throw "Target address outside DFU-Se memory map at 0x" + eraseCursor.toString(16).toUpperCase();
                    }

                    if (!segment.erasable) {
                        this.logWarning("Skipping non-erasable segment at 0x" + eraseCursor.toString(16).toUpperCase());
                        eraseCursor = segment.end;
                        continue;
                    }

                    const sectorStart = getDfuSeSectorStart(segment, eraseCursor);
                    if (sectorStart === null) {
                        throw "Invalid DFU-Se sector information near 0x" + eraseCursor.toString(16).toUpperCase();
                    }

                    if (!erasedSectors.has(sectorStart)) {
                        let eraseCmd = new ArrayBuffer(5);
                        let eraseCmdView = new DataView(eraseCmd);
                        eraseCmdView.setUint8(0, 0x41);
                        eraseCmdView.setUint32(1, sectorStart, true);

                        try {
                            await this.download(eraseCmd, dfuSeCommandBlock);
                            let eraseStatus = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
                            if (eraseStatus.status != dfu.STATUS_OK) {
                                throw `DFU ERASE failed state=${eraseStatus.state}, status=${eraseStatus.status}`;
                            }
                        } catch (error) {
                            throw "Error during DFU erase: " + error;
                        }

                        erasedSectors.add(sectorStart);
                    }

                    eraseCursor = Math.min(sectorStart + segment.sectorSize, segment.end);
                }

                this.logInfo("Erase completed for " + erasedSectors.size + " sector(s)");
            } else {
                this.logWarning("No DFU-Se memory map available; erasing only first target sector");
                let eraseCmd = new ArrayBuffer(5);
                let eraseCmdView = new DataView(eraseCmd);
                eraseCmdView.setUint8(0, 0x41);
                eraseCmdView.setUint32(1, targetAddress, true);

                try {
                    await this.download(eraseCmd, dfuSeCommandBlock);
                    let eraseStatus = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
                    if (eraseStatus.status != dfu.STATUS_OK) {
                        throw `DFU ERASE failed state=${eraseStatus.state}, status=${eraseStatus.status}`;
                    }
                } catch (error) {
                    throw "Error during DFU erase: " + error;
                }
            }

            this.logInfo("📝 Starting DFU-Se data transfer...");
            let address = targetAddress;

            while (bytes_sent < expected_size) {
                const bytes_to_send = Math.min(expected_size - bytes_sent, xfer_size);
                let bytes_written = 0;
                let status;

                let addrCmd = new ArrayBuffer(5);
                let addrCmdView = new DataView(addrCmd);
                addrCmdView.setUint8(0, 0x21);
                addrCmdView.setUint32(1, address, true);

                try {
                    await this.download(addrCmd, dfuSeCommandBlock);
                    status = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
                    if (status.status != dfu.STATUS_OK) {
                        throw `DFU SET_ADDRESS failed state=${status.state}, status=${status.status}`;
                    }

                    bytes_written = await this.download(data.slice(bytes_sent, bytes_sent + bytes_to_send), 2);
                    status = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
                } catch (error) {
                    this.logError("❌ Error at address 0x" + address.toString(16).toUpperCase() + ", offset " + bytes_sent + ": " + error);
                    throw "Error during DFU-Se download: " + error;
                }

                if (status.status != dfu.STATUS_OK) {
                    throw `DFU DOWNLOAD failed state=${status.state}, status=${status.status}`;
                }

                bytes_sent += bytes_written;
                address += bytes_to_send;
                this.logProgress(bytes_sent, expected_size);
            }

            // DfuSe manifestation is more reliable when start address is re-applied.
            let startAddrCmd = new ArrayBuffer(5);
            let startAddrCmdView = new DataView(startAddrCmd);
            startAddrCmdView.setUint8(0, 0x21);
            startAddrCmdView.setUint32(1, targetAddress, true);
            try {
                await this.download(startAddrCmd, dfuSeCommandBlock);
                let status = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
                if (status.status != dfu.STATUS_OK) {
                    throw `DFU SET_ADDRESS failed state=${status.state}, status=${status.status}`;
                }
            } catch (error) {
                throw "Error during DFU-Se manifestation setup: " + error;
            }
        } else {
            transaction = 0;
            this.logInfo("📝 Starting data transfer...");

            while (bytes_sent < expected_size) {
                const bytes_to_send = Math.min(expected_size - bytes_sent, xfer_size);
                let bytes_written = 0;
                let status;

                try {
                    bytes_written = await this.download(data.slice(bytes_sent, bytes_sent + bytes_to_send), transaction++);
                    status = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
                } catch (error) {
                    this.logError("❌ Error at block #" + (transaction - 1) + ", offset " + bytes_sent + ": " + error);
                    throw "Error during DFU download: " + error;
                }

                if (status.status != dfu.STATUS_OK) {
                    throw `DFU DOWNLOAD failed state=${status.state}, status=${status.status}`;
                }

                bytes_sent += bytes_written;
                this.logProgress(bytes_sent, expected_size);
            }
        }
        
        this.logInfo("✅ Data transfer complete: " + bytes_sent + " bytes written");
        
        try {
            this.logDebug("Sending zero-length packet to signal end of download...");
            await this.download(new ArrayBuffer([]), (targetAddress !== null) ? dfuSeCommandBlock : transaction++);
        } catch (error) {
            throw "Error during final DFU download: " + error;
        }
        
        this.logInfo("Wrote " + bytes_sent + " bytes");
        this.logDebug("Manifesting new firmware");
        
        if (manifestationTolerant) {
            let status;
            try {
                status = await this.poll_until(state => (state == dfu.dfuIDLE || state == dfu.dfuMANIFEST_WAIT_RESET));
                if (status.status != dfu.STATUS_OK) {
                    throw `DFU MANIFEST failed state=${status.state}, status=${status.status}`;
                }
            } catch (error) {
                const errStr = error.toString();
                // Device disconnection during manifestation is normal
                if (errStr.includes("Device unavailable") ||
                    errStr.includes("device was disconnected") ||
                    errStr.includes("NetworkError") ||
                    errStr.includes("transfer error")) {
                    this.logInfo("✅ Device disconnected during manifestation (normal behavior)");
                } else {
                    throw "Error during DFU manifest: " + error;
                }
            }
        } else {
            try {
                await this.getStatus();
            } catch (error) {}
        }
        
        // Add delay before reset to ensure firmware is fully written
        this.logDebug("Waiting for firmware to stabilize...");
        await new Promise(resolve => setTimeout(resolve, 500));
        
        try {
            await this.device_.reset();
        } catch (error) {
            const err = error.toString();
            if (!err.includes("Unable to reset") &&
                !err.includes("NetworkError") &&
                !err.includes("Device unavailable") &&
                !err.includes("disconnected")) {
                throw "Error during reset for manifestation: " + error;
            }
            this.logWarning("Device reset complete (expected disconnection)");
        }
    };
}();
