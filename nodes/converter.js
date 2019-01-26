const shepherdConverters = require('zigbee-shepherd-converters');

module.exports = function (RED) {
    RED.httpAdmin.get('/zigbee-shepherd/converters', (req, res) => {
        const converters = shepherdConverters.findByZigbeeModel(req.query.modelId);
        res.status(200).send(JSON.stringify({supports: converters.supports || ''}));
    });

    class ZigbeeConverter {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.models = new Map();

            this.shepherd = shepherdNode.shepherd;
            this.devices = shepherdNode.devices;

            shepherdNode.proxy.on('nodeStatus', status => this.status(status));

            this.on('input', msg => {
                const [name, attr] = (msg.topic || '').split('/');
                const ieeeAddr = config.device || this.getAddrByName(name);
                const device = this.devices[ieeeAddr];

                this.trace('topic=' + msg.topic + ' name=' + name + ' ieeeAddr=' + ieeeAddr + ' payload=' + JSON.stringify(msg.payload));

                if (!device) {
                    this.error('device unknown ' + config.device + ' ' + name + ' ' + ieeeAddr);
                    return;
                }

                const attribute = config.attribute || attr;
                let payload;

                if (attribute) {
                    payload = {};
                    payload[attribute] = msg.payload;
                } else if (typeof msg.payload === 'object') {
                    payload = msg.payload;
                } else {
                    // No attribute supplied, payload not an object - assume state.
                    if (typeof msg.payload !== 'string') {
                        payload = {state: msg.payload ? 'ON' : 'OFF'};
                    }

                    payload = {state: msg.payload};
                }

                this.trace('payload', payload);

                let model;
                // Map device to a model
                if (this.models.has(device.modelId)) {
                    model = this.models.get(device.modelId);
                } else {
                    model = shepherdConverters.findByZigbeeModel(device.modelId);
                    this.models.set(device.modelId, model);
                }

                if (!model) {
                    this.warn(`Device with modelID '${device.modelId}' is not supported.`);
                    this.warn('Please see: https://koenkk.github.io/zigbee2mqtt/how_tos/how_to_support_new_devices.html');
                    return;
                }

                // For each key in the JSON message find the matching converter.
                Object.keys(payload).forEach(key => {
                    const converter = model.toZigbee.find(c => c.key.includes(key));
                    if (!converter) {
                        this.error(`No converter available for '${key}' (${payload[key]})`);
                        return;
                    }

                    // Converter didn't return a result, skip
                    const converted = converter.convert(key, payload[key], payload, 'set');
                    if (!converted) {
                        return;
                    }

                    //console.log('converted', JSON.stringify(converted));
                    // Add job to queue

                    // TODO gain understanding of endpoints. Currently just using the first one due to missing knowledge.
                    shepherdNode.proxy.queue(Object.assign(converted, {ieeeAddr: device.ieeeAddr, ep: device.epList[0]}));

                    /* TODO clarify!
                              // Devices do not report when they go off, this ensures state (on/off) is always in sync.
                              if (topic.type === 'set' && !error && (key.startsWith('state') || key === 'brightness')) {
                                  const msg = {};
                                  const _key = topic.postfix ? `state_${topic.postfix}` : 'state';
                                  msg[_key] = key === 'brightness' ? 'ON' : payload['state'];
                                  this.publishDeviceState(device, msg, true);
                              }
                              */

                    /*
                        // When there is a transition in the message the state of the device gets out of sync.
                        // Therefore; at the end of the transition, read the new state from the device.
                        if (topic.type === 'set' && converted.zclData.transtime) {
                            const time = converted.zclData.transtime * 100;
                            const getConverted = converter.convert(key, payload[key], payload, 'get');
                            setTimeout(() => {
                                // Add job to queue
                                this.queue.push((queueCallback) => {
                                    this.zigbee.publish(
                                        ieeeAddr, getConverted.cid, getConverted.cmd, getConverted.cmdType,
                                        getConverted.zclData, getConverted.cfg, endpoint, () => queueCallback()
                                    );
                                });
                            }, time);
                        }
                        */
                });
            });

            shepherdNode.proxy.on('ind', message => {
                const device = message.endpoints && message.endpoints[0] && message.endpoints[0].device;

                if (message.type === 'attReport' || message.type === 'devChange') {
                    if (!device) {
                        this.warn('unknown device', message);
                        return;
                    }

                    if (config.device && config.device !== device.ieeeAddr) {
                        return;
                    }

                    const out = {
                        topic: (this.devices[device.ieeeAddr] && this.devices[device.ieeeAddr].name) || device.ieeeAddr,
                        payload: null,
                        name: (this.devices[device.ieeeAddr] && this.devices[device.ieeeAddr].name),
                        type: device.type,
                        manufName: device.manufName,
                        modelId: device.modelId,
                        ieeeAddr: device.ieeeAddr,
                        cid: message.data.cid,
                        data: message.data.data
                    };

                    let model;
                    // Map device to a model
                    if (this.models.has(device.modelId)) {
                        model = this.models.get(device.modelId);
                    } else {
                        model = shepherdConverters.findByZigbeeModel(device.modelId);
                        this.models.set(device.modelId, model);
                    }

                    if (model) {
                        // Find a converter for this message.
                        const {cid, cmdId} = message.data;
                        const converters = model.fromZigbee.filter(c => {
                            if (cid) {
                                return c.cid === cid && c.type === message.type;
                            }

                            if (cmdId) {
                                return c.cmd === cmdId;
                            }

                            return false;
                        });

                        // Check if there is an available converter
                        if (converters.length > 0) {
                            if (config.payload === 'json') {
                                out.payload = {};
                            }

                            converters.forEach(converter => {
                                const convertedPayload = converter.convert(model, message, () => {}, {});

                                if (convertedPayload) {
                                    if (config.payload === 'plain') {
                                        Object.keys(convertedPayload).forEach(key => {
                                            if (config.attribute === '' || config.attribute === key) {
                                                this.send(Object.assign({}, out, {
                                                    topic: out.topic + '/' + key,
                                                    payload: convertedPayload[key]
                                                }));
                                            }
                                        });
                                    } else {
                                        Object.assign(out.payload, convertedPayload);
                                    }
                                }
                            });
                            if (config.payload === 'json' && Object.keys(out.payload).length > 0) {
                                this.send(out);
                            }
                        } else {
                            if (cid) {
                                this.warn(
                                    `No converter available for '${model.model}' with cid '${cid}', ` +
                                    `type '${message.type}' and data '${JSON.stringify(message.data)}'`
                                );
                            } else if (cmdId) {
                                this.warn(
                                    `No converter available for '${model.model}' with cmd '${cmdId}' ` +
                                    `and data '${JSON.stringify(message.data)}'`
                                );
                            }

                            this.warn('Please see: https://koenkk.github.io/zigbee2mqtt/how_tos/how_to_support_new_devices.html.');
                        }
                    }
                }
            });
        }

        getAddrByName(name) {
            const dev = Object.keys(this.devices).map(addr => this.devices[addr]).filter(dev => dev.name === name);
            return dev && dev.ieeeAddr;
        }
    }

    RED.nodes.registerType('zigbee-converter', ZigbeeConverter);
};
