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

            this.on('input', msg => {
                const topic = (msg.topic || '').split('/');
                const settopic = (config.settopic || '').split('/');
                const topicAttrs = {};
                for (let i = 0; i < topic.length; i++) {
                    const match = settopic[i].match(/\${([^}]+)}/);
                    if (match) {
                        topicAttrs[match[1]] = topic[i];
                    } else if (topic[i] !== settopic[i]) {
                        this.debug('topic mismatch ' + msg.topic + ' ' + config.settopic);
                        return;
                    }
                }

                const ieeeAddr = config.device || topicAttrs.ieeeAddr || (topicAttrs.name && this.getAddrByName(topicAttrs.name));
                const device = this.devices[ieeeAddr];
                const name = topicAttrs.name || (device && device.name);
                const attribute = config.attribute || topicAttrs.attribute;

                this.debug('topic=' + msg.topic + ' name=' + name + ' ieeeAddr=' + ieeeAddr + ' attribute=' + attribute + ' payload=' + JSON.stringify(msg.payload));

                if (!device) {
                    this.error('device unknown ' + name + ' ' + ieeeAddr);
                    return;
                }

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

                this.debug('payload ' + JSON.stringify(payload));

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

                    const converted = converter.convert(key, payload[key], payload, 'set');

                    // Converter didn't return a result, skip
                    if (!converted) {
                        this.warn('no conversion for ' + key);
                        return;
                    }

                    // Add job to queue
                    shepherdNode.proxy.queue(Object.assign(converted, {
                        ieeeAddr: device.ieeeAddr,
                        // TODO gain understanding of endpoints. Currently just using the first one due to missing knowledge.
                        ep: device.epList[0],
                        callback: (err, res) => {
                            /* TODO clarify!
                            // Devices do not report when they go off, this ensures state (on/off) is always in sync.
                            if (topic.type === 'set' && !error && (key.startsWith('state') || key === 'brightness')) {
                                const msg = {};
                                const _key = topic.postfix ? `state_${topic.postfix}` : 'state';
                                msg[_key] = key === 'brightness' ? 'ON' : payload['state'];
                                this.publishDeviceState(device, msg, true);
                            }
                            */

                            // When there is a transition in the message the state of the device gets out of sync.
                            // Therefore; at the end of the transition, read the new state from the device.
                            if (err || converted.zclData.transtime) {
                                const time = ((converted.zclData.transtime || 0) * 100) + 250;
                                const getConverted = converter.convert(key, payload[key], payload, 'get');
                                if (getConverted) {
                                    setTimeout(() => {
                                        // Add job to queue
                                        shepherdNode.proxy.queue(Object.assign(getConverted, {ieeeAddr: device.ieeeAddr, ep: device.epList[0]}));
                                    }, time);
                                }
                            }
                        }
                    }));
                });
            });

            const indHandler = message => {
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
                        topic: null,
                        payload: null,
                        name: (this.devices[device.ieeeAddr] && this.devices[device.ieeeAddr].name),
                        type: device.type,
                        manufName: device.manufName,
                        modelId: device.modelId,
                        ieeeAddr: device.ieeeAddr,
                        cid: message.data.cid,
                        data: message.data.data
                    };

                    out.topic = this.topicReplace(config.topic, out);

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
                            if (c.cid === cid) {
                                if (Array.isArray(c.type)) {
                                    return c.type.includes(message.type);
                                }

                                return c.type === message.type;
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
                                                    payload: convertedPayload[key],
                                                    retain: !['click'].includes(key)
                                                }));
                                            }
                                        });
                                    } else {
                                        Object.assign(out.payload, convertedPayload);
                                        if (Object.keys(out.payload).length > 0) {
                                            this.send(out);
                                        }
                                    }
                                }
                            });
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
            };

            const nodeStatusHandler = status => {
                this.status(status);
            };

            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            shepherdNode.proxy.on('ind', indHandler);
            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);

            this.on('close', () => {
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                shepherdNode.proxy.removeListener('ind', indHandler);
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
            });
        }

        getAddrByName(name) {
            const dev = Object.keys(this.devices).map(addr => this.devices[addr]).filter(dev => dev.name === name);
            return dev && dev.ieeeAddr;
        }

        topicReplace(topic, msg) {
            if (!topic || typeof msg !== 'object') {
                return topic;
            }

            const msgLower = {};
            Object.keys(msg).forEach(k => {
                msgLower[k.toLowerCase()] = msg[k];
            });

            const match = topic.match(/\${[^}]+}/g);
            if (match) {
                match.forEach(v => {
                    const key = v.substr(2, v.length - 3);
                    const rx = new RegExp('\\${' + key + '}', 'g');
                    const rkey = key.toLowerCase();
                    topic = topic.replace(rx, msgLower[rkey] || '');
                });
            }

            return topic;
        }
    }

    RED.nodes.registerType('zigbee-converter', ZigbeeConverter);
};
