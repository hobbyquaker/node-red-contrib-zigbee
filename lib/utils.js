module.exports = {
    isXiaomiDevice: device => {
        return device.modelID !== 'lumi.router' && [4151, 4447].includes(device.manufacturerID) &&
            (!device.manufacturerName || !device.manufacturerName.startsWith('Trust'));
    },
    isIkeaTradfriDevice: device => [4476].includes(device.manufacturerID),
    isRouter: device => device.type === 'Router', //&& !forceEndDevice.includes(device.modelID),
    isBatteryPowered: device => device.powerSource && device.powerSource === 'Battery'
};
