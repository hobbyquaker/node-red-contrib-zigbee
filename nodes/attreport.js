const shepherdConverters = require('zigbee-shepherd-converters');

module.exports = function (RED) {
    class ZigbeeAttReport {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherd = shepherdNode.shepherd;

            this.shepherd.on('ind', message => {
                const device = message.endpoints[0].device;

                if (!device) {
                    console.log('no device', message)
                    return;
                }

                if (message.type === 'attReport') {
                    const out = {
                        topic: device.ieeeAddr,
                        type: device.type,
                        manufName: device.manufName,
                        modelId: device.modelId,
                        ieeeAddr: device.ieeeAddr,
                        cid: message.data.cid,
                        data: message.data.data
                    };

                    const mappedDevice = shepherdConverters.findByZigbeeModel(device.modelId);

                    if (mappedDevice) {
                        // Find a converter for this message.
                        const cid = message.data.cid;
                        const cmdId = message.data.cmdId;
                        const converters = mappedDevice.fromZigbee.filter((c) => {
                            if (cid) {
                                return c.cid === cid && c.type === message.type;
                            } else if (cmdId) {
                                return c.cmd === cmdId;
                            }

                            return false;
                        });

                        // Check if there is an available converter
                        if (!converters.length) {
                            if (cid) {
                                this.warn(
                                    `No converter available for '${mappedDevice.model}' with cid '${cid}', ` +
                                    `type '${message.type}' and data '${JSON.stringify(message.data)}'`
                                );
                            } else if (cmdId) {
                                this.warn(
                                    `No converter available for '${mappedDevice.model}' with cmd '${cmdId}' ` +
                                    `and data '${JSON.stringify(message.data)}'`
                                );
                            }

                            this.warn(`Please see: https://koenkk.github.io/zigbee2mqtt/how_tos/how_to_support_new_devices.html.`);
                            this.send(out);
                        } else {
                            converters.forEach(converter => {
                                const convertedPayload = converter.convert(mappedDevice, message, payload => {}, {});

                                if (convertedPayload) {
                                    Object.keys(convertedPayload).forEach(key => {
                                        this.send(Object.assign({}, out, {topic: out.topic + '/' + key, payload: convertedPayload[key]}));
                                    });
                                } else {
                                    this.send(out);
                                }

                            });
                        }
                    }


                }
            });
        }
    }

    RED.nodes.registerType('zigbee-attreport', ZigbeeAttReport);
};
